/**
 * 故事归属（task-95 rev2）：**按查看者本人隔离**，不是"家庭共享作者身份"。
 *
 * 用户澄清：「每个人都只能看到自己的录音和输入的原文，只有最后的英文句子是家庭可见的」。
 *  - 英文正文：家庭可见（任何家庭成员都能看故事详情/打印）
 *  - 中文原文、原始录音、朗读记录/趋势/复述、整段拼接回放：**仅故事创建者本人**
 *  - 因此 `isOwner = user.id === material.createdBy`（历史数据 createdBy 为 null → 非 owner）
 */
import type { MaterialRow } from "@/lib/materials";
import type { SessionUser } from "@/lib/auth";

export function isStoryOwner(user: SessionUser, material: Pick<MaterialRow, "createdBy">): boolean {
  return Boolean(material.createdBy) && user.id === material.createdBy;
}
