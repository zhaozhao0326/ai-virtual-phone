const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);
const FALSE_VALUES = new Set(["0", "false", "no", "off"]);

/**
 * 是否处于自部署模式（跳过作者官方账号/激活码门禁，用本地单机账号直接进手机）。
 *
 * 取值顺序：
 * 1. 环境变量 NEXT_PUBLIC_SELF_HOSTED_MODE 显式给了真/假值 → 按它；
 * 2. 未设置 → 默认视为自部署开启（见 .env.example：自部署默认推荐开启）。
 *    这样即使部署平台没有注入环境变量、或部署包没带上 .env 文件，
 *    自建部署也不会被账号门禁挡在外面。
 *
 * 想重新打开登录门禁：NEXT_PUBLIC_SELF_HOSTED_MODE=false
 */
export function isSelfHostedModeEnabled(): boolean {
  const raw = (process.env.NEXT_PUBLIC_SELF_HOSTED_MODE || "").trim().toLowerCase();
  if (FALSE_VALUES.has(raw)) return false;
  // 显式真值、或未设置/无法识别 —— 都按自部署开启处理
  return TRUE_VALUES.has(raw) || raw === "";
}
