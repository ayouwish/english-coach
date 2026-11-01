/**
 * 插画角色描述（task-76 ②）：**必须明确性别**，否则文生图会默认画成男孩。
 *
 * 规则：
 *  - 已选虚拟形象 → 用形象的 `desc_en`（已含性别词），再补年龄（可选）；
 *  - 未选形象但有性别 → `a girl about 8 years old` / `a boy ...`（成人 woman/man）；
 *  - 未设性别 → 中性 `a child`（不瞎猜性别）。
 * 儿童安全：不拼任何身体/敏感描述，只用性别 + 年龄 + 形象描述。
 */
export function genderPhrase(gender: string | null | undefined, age: number | null): string | null {
  if (!gender) return null;
  const base =
    gender === "girl" ? "a girl" : gender === "boy" ? "a boy" : gender === "woman" ? "a woman" : gender === "man" ? "a man" : "a child";
  if (gender === "other") return age ? `a child about ${age} years old` : "a child";
  return age ? `${base} about ${age} years old` : base;
}

/** 拼出最终传给 voice 的 character_desc（空串 = 不带角色参考） */
export function buildCharacterDesc(input: {
  gender: string | null | undefined;
  birthYear: number | null | undefined;
  avatarDesc?: string | null;
}): string {
  const currentYear = new Date().getFullYear();
  const age = input.birthYear ? Math.max(3, currentYear - input.birthYear) : null;
  const avatarDesc = (input.avatarDesc ?? "").trim();
  if (avatarDesc) {
    // 形象描述已含性别（预置 desc_en 都是 a child with ...，由形象元数据保证）→ 用它；年龄可选补充
    return avatarDesc.length > 0 ? `${avatarDesc}${age ? `, about ${age} years old` : ""}` : avatarDesc;
  }
  return genderPhrase(input.gender, age) ?? "a child";
}

export function ageFromBirthYear(birthYear: number | null | undefined): number | null {
  if (!birthYear) return null;
  return Math.max(3, new Date().getFullYear() - birthYear);
}
