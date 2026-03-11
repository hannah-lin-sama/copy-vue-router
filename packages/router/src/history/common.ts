import { isBrowser } from '../utils'
import { removeTrailingSlash } from '../location'

export type HistoryLocation = string
/**
 * Allowed variables in HTML5 history state. Note that pushState clones the state
 * passed and does not accept everything: e.g.: it doesn't accept symbols, nor
 * functions as values. It also ignores Symbols as keys.
 *
 * @internal
 */
export type HistoryStateValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | HistoryState
  | HistoryStateArray

/**
 * Allowed HTML history.state
 */
export interface HistoryState {
  [x: number]: HistoryStateValue
  [x: string]: HistoryStateValue
}

/**
 * Allowed arrays for history.state.
 *
 * @internal
 */
export interface HistoryStateArray extends Array<HistoryStateValue> {}

export enum NavigationType {
  pop = 'pop',
  push = 'push',
}

export enum NavigationDirection {
  back = 'back',
  forward = 'forward',
  unknown = '',
}

export interface NavigationInformation {
  type: NavigationType
  direction: NavigationDirection
  delta: number
}

export interface NavigationCallback {
  (
    to: HistoryLocation,
    from: HistoryLocation,
    information: NavigationInformation
  ): void
}

/**
 * Starting location for Histories
 */
export const START: HistoryLocation = ''

export type ValueContainer<T> = { value: T }

/**
 * Interface implemented by History implementations that can be passed to the
 * router as {@link Router.history}
 * 路由历史管理器统一接口
 * @alpha
 */
export interface RouterHistory {
  /**
   * Base path that is prepended to every url. This allows hosting an SPA at a
   * sub-folder of a domain like `example.com/sub-folder` by having a `base` of
   * `/sub-folder`
   */
  readonly base: string // 路由基础路径	用于 SPA 部署在子目录
  /**
   * Current History location
   */
  readonly location: HistoryLocation // 当前路由地址, 字符串
  /**
   * Current History state
   */
  readonly state: HistoryState // 当前历史记录状态	对应浏览器原生 history.state
  // readonly location: ValueContainer<HistoryLocationNormalized>

  /**
   * Navigates to a location. In the case of an HTML5 History implementation,
   * this will call `history.pushState` to effectively change the URL.
   * 新增一条历史记录，对应浏览器 history.pushState（无刷新跳转）
   * @param to - location to push
   * @param data - optional {@link HistoryState} to be associated with the
   * navigation entry
   */
  push(to: HistoryLocation, data?: HistoryState): void
  /**
   * Same as {@link RouterHistory.push} but performs a `history.replaceState`
   * instead of `history.pushState`
   * 替换当前历史记录，对应浏览器 history.replaceState（无刷新替换，不新增记录）
   * @param to - location to set
   * @param data - optional {@link HistoryState} to be associated with the
   * navigation entry
   */
  replace(to: HistoryLocation, data?: HistoryState): void

  /**
   * Traverses history in a given direction.
   *
   * @example
   * ```js
   * myHistory.go(-1) // equivalent to window.history.back()
   * myHistory.go(1) // equivalent to window.history.forward()
   * ```
   * 前进 / 后退历史记录，对应浏览器 history.go
   * @param delta - distance to travel. If delta is \< 0, it will go back,
   * if it's \> 0, it will go forward by that amount of entries.
   * @param triggerListeners - whether this should trigger listeners attached to
   * the history
   */
  go(delta: number, triggerListeners?: boolean): void

  /**
   * Attach a listener to the History implementation that is triggered when the
   * navigation is triggered from outside (like the Browser back and forward
   * buttons) or when passing `true` to {@link RouterHistory.back} and
   * {@link RouterHistory.forward}
   * 监听路由变化（如浏览器后退 / 前进、手动修改 URL）
   * @param callback - listener to attach
   * @returns a callback to remove the listener
   */
  listen(callback: NavigationCallback): () => void

  /**
   * Generates the corresponding href to be used in an anchor tag.
   * 生成可用于 <a> 标签的完整 URL
   * @param location - history location that should create an href
   */
  createHref(location: HistoryLocation): string

  /**
   * Clears any event listener attached by the history implementation.
   * 清理历史管理器的所有事件监听（如 popstate 事件）、重置状态
   */
  destroy(): void
}

// Generic utils

/**
 * Normalizes a base by removing any trailing slash and reading the base tag if
 * present.
 *
 * @param base - base to normalize
 */
export function normalizeBase(base?: string): string {
  // 1. 处理空 base
  if (!base) {
    // 2. 处理浏览器环境下的 base 标签
    if (isBrowser) {
      // respect <base> tag
      const baseEl = document.querySelector('base') // 3. 查找 base 标签
      base = (baseEl && baseEl.getAttribute('href')) || '/' // 4. 获取 base 标签的 href 属性，若不存在则设为 '/'
      // strip full URL origin
      // [^\/] = 否定字符集，匹配除了 / 之外的任意字符
      base = base.replace(/^\w+:\/\/[^\/]+/, '') // 5. 移除 URL .origin，保留路径部分
    } else {
      base = '/' // 6. 非浏览器环境下，设为根路径 '/'
    }
  }

  // ensure leading slash when it was removed by the regex above avoid leading
  // slash with hash because the file could be read from the disk like file://
  // and the leading slash would cause problems
  // 7. 确保 base 以 / 或 # 开头
  if (base[0] !== '/' && base[0] !== '#') base = '/' + base

  // remove the trailing slash so all other method can just do `base + fullPath`
  // to build an href
  // 8. 移除路径末尾的斜杠，避免重复斜杠问题
  return removeTrailingSlash(base)
}

// remove any character before the hash
const BEFORE_HASH_RE = /^[^#]+#/

/**
 *  Hash 模式下生成标准化跳转链接（href）
 * Hash 模式的核心是「路由路径存储在 # 之后」，浏览器会忽略 # 之前的内容（视为锚点前缀）
 * @param base 路由基础路径
 * @param location 路由路径（相对路径）
 * @returns 完整的 href 路径
 */
export function createHref(base: string, location: HistoryLocation): string {
  return base.replace(BEFORE_HASH_RE, '#') + location
}
