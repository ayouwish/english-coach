import Link from "next/link";
import { redirect } from "next/navigation";
import { ensureBootstrap } from "@/db";
import { AudioButton } from "@/components/AudioButton";
import { ArticulationDemo } from "@/components/ArticulationDemo";
import { getArticulation } from "@/lib/articulation";
import type { Articulation } from "@/lib/articulation";
import { getCurrentUser } from "@/lib/auth";
import { buildDiagnosis, buildDiagnosisRaw, toChildArticulation, type DiagnosisItem } from "@/lib/diagnosis";

export const dynamic = "force-dynamic";

/**
 * /report —— 发音诊断（task-16 B）。
 * 数据来自 phoneme_mastery 聚合；每个薄弱音素一张卡：口型动画微课 + 要点 + 常见错误 +
 * 示范音 + 例词 + 最小对立对 + 「去练这 N 句」。
 *
 * 儿童硬约束：只用 childLabel / tipChildZh / examples；不给 IPA、不给常见错误（成人向）。
 * 下发给 client 组件的 articulation 对象也会先剥掉 ipa 字段。
 */
export default async function ReportPage() {
  await ensureBootstrap();
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const isChild = user.isChild;
  // raw：含 IPA，仅在服务端用于查发音参数（不会下发给浏览器）
  // safe：儿童版本（文案已剥离 IPA），用于渲染文字
  const raw = await buildDiagnosisRaw(user);
  const safe = isChild ? await buildDiagnosis(user) : null;
  const views = raw.items.map((r, i) => ({ raw: r, view: isChild ? safe!.items[i] : r }));

  const visible = views.filter((v) => v.view.status !== "ok");
  const okItems = views.filter((v) => v.view.status === "ok");
  const summary = isChild ? safe!.summary_zh : raw.summary_zh;

  const artFor = (ipa: string): Articulation | null => {
    const a = getArticulation(ipa);
    if (!a) return null;
    return isChild ? toChildArticulation(a) : a;
  };

  const startView = views.find((v) => v.view.status === "weak")?.view ?? views[0]?.view;
  const startToken = startView?.focus_token ?? raw.focus_phonemes[0];
  const startIpa = isChild ? null : startView?.phoneme;

  return (
    <div className="flex flex-col gap-5" data-testid="report-page">
      <section className="ec-card">
        <h1 className="text-xl font-extrabold">{isChild ? "🔍 我的发音报告" : "🔍 发音诊断报告"}</h1>
        <p className="mt-2 text-base font-semibold" data-testid="diagnosis-summary">
          {summary}
        </p>
        <p className="mt-1 text-xs text-[var(--ec-muted)]">
          统计口径：每个音素至少 {raw.min_samples} 次记录才计入（共 {raw.counted_phonemes} 个达标，
          薄弱 {raw.counts.weak} / 待巩固 {raw.counts.watch} / 已掌握 {raw.counts.ok}）。
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          {startToken ? (
            <Link
              className="ec-btn ec-btn-primary"
              href={`/practice?focus=${encodeURIComponent(startToken)}`}
              data-testid="start-intensive"
            >
              🚀 开始强化练习
              {startIpa && !isChild ? `（/${startIpa}/）` : ""}
            </Link>
          ) : (
            <Link className="ec-btn ec-btn-primary" href="/practice">
              去跟读练习
            </Link>
          )}
        </div>
      </section>

      {visible.length === 0 ? (
        <section className="ec-card">
          <p className="text-sm" data-testid="no-weak-phonemes">
            目前没有明显薄弱的音素 🎉 继续日常跟读就好；多读几句之后这里会自动出现诊断卡片。
          </p>
        </section>
      ) : (
        visible.map(({ raw: rawItem, view }, idx) => {
          const primary = artFor(rawItem.phoneme);
          if (!primary) return null;
          // 对比音素只在服务端用于画图；文案用 view（儿童版已剥离 IPA）
          const contrastIpa = rawItem.contrasts[0]?.phoneme ?? null;
          const contrast = contrastIpa ? artFor(contrastIpa) : null;
          const compareNote = view.contrasts[0]?.note ?? null;
          return (
            <ReportCard
              // key 不能用音素符号：React 会把 key 序列化进 RSC 负载，儿童页会因此泄漏 IPA
              key={`card-${idx}`}
              item={view}
              primary={primary}
              contrast={contrast}
              compareNote={compareNote}
              isChild={isChild}
            />
          );
        })
      )}

      {okItems.length > 0 ? (
        <details className="ec-card" data-testid="ok-phonemes">
          <summary className="cursor-pointer font-bold">
            已经掌握的音素（{okItems.length}）· 点击展开
          </summary>
          <ul className="mt-2 flex flex-wrap gap-2 text-sm">
            {okItems.map(({ raw: rawItem, view }, idx) => (
              <li key={`ok-${idx}`} className="rounded-lg bg-[#eef0f8] px-2 py-1">
                {isChild ? view.child_label : `${rawItem.phoneme} · ${view.child_label}`}（{view.avg_score} 分）
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      <p className="text-xs text-[var(--ec-muted)]">
        诊断依据：每个音素的历次评测均分与最近 3 次趋势；1 次的记录不参与（噪声太大）。
      </p>
    </div>
  );
}

function ReportCard({
  item,
  primary,
  contrast,
  compareNote,
  isChild,
}: {
  item: DiagnosisItem;
  primary: Articulation;
  contrast: Articulation | null;
  compareNote: string | null;
  isChild: boolean;
}) {
  const demoText = item.examples.slice(0, 3).join(", ");
  const title = isChild ? item.child_label : `/${item.phoneme}/ · ${item.child_label}`;
  return (
    <section
      className={`ec-card ${item.status === "weak" ? "border-2 border-[#f5c26b]" : ""}`}
      data-testid="report-card"
      data-status={item.status}
      data-phoneme={isChild ? "" : item.phoneme}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-lg font-extrabold">{title}</h2>
        <p className="text-sm">
          <strong className="text-lg">{item.avg_score}</strong> 分 · {item.attempts} 次记录
          {item.trend.delta !== null ? (
            <span className="ml-2 text-xs text-[var(--ec-muted)]">
              近 3 次 {item.trend.direction === "improving" ? "↗ 在进步" : item.trend.direction === "declining" ? "↘ 略有下滑" : "→ 基本持平"}
              （{item.trend.delta > 0 ? "+" : ""}
              {item.trend.delta}）
            </span>
          ) : null}
        </p>
      </div>

      <div className="mt-3 grid gap-4 md:grid-cols-2">
        <ArticulationDemo
          primary={primary}
          compareWith={contrast}
          compareNote={compareNote}
          isChild={isChild}
          size={isChild ? 320 : 280}
        />

        <div className="flex flex-col gap-3 text-sm">
          <div>
            <h3 className="font-bold">👄 口型要点</h3>
            <p className="mt-1">{isChild ? item.tip_child_zh : item.tip_zh}</p>
          </div>

          {!isChild && item.common_errors.length > 0 ? (
            <div>
              <h3 className="font-bold">⚠️ 常见错误</h3>
              <ul className="mt-1 list-disc pl-5">
                {item.common_errors.map((e) => (
                  <li key={e}>{e}</li>
                ))}
              </ul>
            </div>
          ) : null}

          <div>
            <h3 className="font-bold">🔊 示范音</h3>
            <div className="mt-1 flex flex-wrap gap-2">
              <AudioButton text={demoText} rate="slow" testid="demo-audio">
                播放示范
              </AudioButton>
              {item.examples.map((w) => (
                <AudioButton key={w} text={w} rate="slow" className="!px-2 !py-1 text-xs" testid="example-audio">
                  {w}
                </AudioButton>
              ))}
            </div>
          </div>

          {item.contrasts.length > 0 ? (
            <div>
              <h3 className="font-bold">🔀 最容易混的音</h3>
              {item.contrasts.slice(0, 2).map((c, idx) => (
                <p key={idx} className="mt-1 text-[var(--ec-muted)]">
                  {/* 儿童已剥离对比音素符号，只展示对比词与说明 */}
                  {c.pair[0]} ↔ {c.pair[1]}：{c.note}
                  <AudioButton text={`${c.pair[0]}, ${c.pair[1]}`} rate="slow" className="ml-2 !px-2 !py-0.5 text-xs">
                    对比听
                  </AudioButton>
                </p>
              ))}
            </div>
          ) : null}

          <div className="flex flex-wrap items-center gap-2">
            <Link
              className="ec-btn ec-btn-primary"
              href={`/practice?focus=${encodeURIComponent(item.focus_token)}`}
              data-testid="practice-focus"
            >
              🎯 去练这 {item.practice_count > 0 ? item.practice_count : "几"} 句
            </Link>
            {item.error_words.length > 0 ? (
              <span className="text-xs text-[var(--ec-muted)]">
                相关的词：{item.error_words.map((w) => w.word).join(" · ")}
              </span>
            ) : null}
          </div>
        </div>
      </div>
    </section>
  );
}
