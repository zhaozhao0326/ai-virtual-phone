// node loader：供 --experimental-strip-types 回归脚本使用
// 1) 把 '@/xxx' 映射到项目根 './xxx'
// 2) 相对导入无扩展名时补 '.ts'
import { pathToFileURL, fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

export async function resolve(specifier, context, next) {
    const needsTs = (s) => !/\.(js|mjs|cjs|json|ts|mts|cts)$/.test(s);
    if (specifier.startsWith("@/") && needsTs(specifier)) {
        return next(pathToFileURL(path.join(ROOT, specifier.slice(2)) + ".ts").href, context);
    }
    if ((specifier.startsWith("./") || specifier.startsWith("../")) && needsTs(specifier)) {
        const parentPath = context.parentURL ? path.dirname(fileURLToPath(context.parentURL)) : ROOT;
        return next(pathToFileURL(path.resolve(parentPath, specifier + ".ts")).href, context);
    }
    return next(specifier, context);
}
