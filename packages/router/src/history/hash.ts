import { RouterHistory } from './common'
import { createWebHistory } from './html5'
import { warn } from '../warning'

/**
 * Creates a hash history. Useful for web applications with no host (e.g. `file://`) or when configuring a server to
 * handle any URL is not possible.
 *
 * @param base - optional base to provide. Defaults to `location.pathname + location.search` If there is a `<base>` tag
 * in the `head`, its value will be ignored in favor of this parameter **but note it affects all the history.pushState()
 * calls**, meaning that if you use a `<base>` tag, it's `href` value **has to match this parameter** (ignoring anything
 * after the `#`).
 *
 * @example
 * ```js
 * // at https://example.com/folder
 * createWebHashHistory() // gives a url of `https://example.com/folder#`
 * createWebHashHistory('/folder/') // gives a url of `https://example.com/folder/#`
 * // if the `#` is provided in the base, it won't be added by `createWebHashHistory`
 * createWebHashHistory('/folder/#/app/') // gives a url of `https://example.com/folder/#/app/`
 * // you should avoid doing this because it changes the original url and breaks copying urls
 * createWebHashHistory('/other-folder/') // gives a url of `https://example.com/other-folder/#`
 *
 * // at file:///usr/etc/folder/index.html
 * // for locations with no `host`, the base is ignored
 * createWebHashHistory('/iAmIgnored') // gives a url of `file:///usr/etc/folder/index.html#`
 * ```
 */

/**
 * 创建基于 Hash 模式的路由历史对象
 * @param base - 选的基础路径（比如 /admin），用于给 Hash 路由添加前缀，默认值为 `location.pathname + location.search`
 * @returns 路由历史对象
 */
export function createWebHashHistory(base?: string): RouterHistory {
  // Make sure this implementation is fine in terms of encoding, specially for IE11
  // for `file://`, directly use the pathname and ignore the base
  // location.pathname contains an initial `/` even at the root: `https://example.com`
  // 1. 区分环境
  // 如果是 file:// 协议（本地文件），忽略 base，直接用 pathname + search；
  // 否则用传入的 base 或空字符串
  base = location.host ? base || location.pathname + location.search : ''
  // allow the user to provide a `#` in the middle: `/base/#/app`
  // 2、确保 base 中包含 #：如果用户没传 #，自动追加到 base 末尾
  if (!base.includes('#')) base += '#'

  // 3. 开发环境校验：base 必须以 # 或 #/ 结尾，否则给出警告
  if (__DEV__ && !base.endsWith('#/') && !base.endsWith('#')) {
    warn(
      `A hash base must end with a "#":\n"${base}" should be "${base.replace(/#.*$/, '#')}".`
    )
  }
  // 复用 createWebHistory 实现，只是 base 不同
  return createWebHistory(base)
}
