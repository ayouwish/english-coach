import { HttpError, type SessionUser } from "./auth";
import { getDailyUsage, type DailyUsage } from "./usage";

export const DAILY_LIMIT_CODE = "daily_limit_reached";

/** 儿童到点后友好收尾：服务端强制，不只是前端提示。 */
export async function assertWithinDailyLimit(user: SessionUser): Promise<DailyUsage> {
  const usage = await getDailyUsage(user.id, user.dailyLimitMinutes);
  if (user.isChild && usage.exceeded) {
    throw new HttpError(
      429,
      DAILY_LIMIT_CODE,
      `今天已经练习 ${usage.minutes} 分钟啦，达到 ${usage.limitMinutes} 分钟上限，明天再来吧 🌙`,
      usage,
    );
  }
  return usage;
}
