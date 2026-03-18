import type {
  RouteLocationNormalized,
  RouteLocationNormalizedLoaded,
} from './typed-routes'
import { warn } from './warning'

// we use types instead of interfaces to make it work with HistoryStateValue type

/**
 * Scroll position similar to
 * {@link https://developer.mozilla.org/en-US/docs/Web/API/ScrollToOptions | `ScrollToOptions`}.
 * Note that not all browsers support `behavior`.
 */
export type ScrollPositionCoordinates = {
  behavior?: ScrollOptions['behavior']
  left?: number
  top?: number
}

/**
 * Internal normalized version of {@link ScrollPositionCoordinates} that always
 * has `left` and `top` coordinates. Must be a type to be assignable to HistoryStateValue.
 *
 * @internal
 */
export type _ScrollPositionNormalized = {
  behavior?: ScrollOptions['behavior']
  left: number
  top: number
}

/**
 * Type of the `scrollBehavior` option that can be passed to `createRouter`.
 */
export interface RouterScrollBehavior {
  /**
   * @param to - Route location where we are navigating to
   * @param from - Route location where we are navigating from
   * @param savedPosition - saved position if it exists, `null` otherwise
   */
  (
    to: RouteLocationNormalized,
    from: RouteLocationNormalizedLoaded,
    savedPosition: _ScrollPositionNormalized | null
  ): Awaitable<ScrollPosition | false | void>
}

export interface ScrollPositionElement extends ScrollToOptions {
  /**
   * A valid CSS selector. Note some characters must be escaped in id selectors (https://mathiasbynens.be/notes/css-escapes).
   * @example
   * Here are a few examples:
   *
   * - `.title`
   * - `.content:first-child`
   * - `#marker`
   * - `#marker\~with\~symbols`
   * - `#marker.with.dot`: selects `class="with dot" id="marker"`, not `id="marker.with.dot"`
   *
   */
  el: string | Element
}

export type ScrollPosition = ScrollPositionCoordinates | ScrollPositionElement

type Awaitable<T> = T | PromiseLike<T>

export interface ScrollBehaviorHandler<T> {
  (
    to: RouteLocationNormalized,
    from: RouteLocationNormalizedLoaded,
    savedPosition: T | void
  ): Awaitable<ScrollPosition | false | void>
}

function getElementPosition(
  el: Element, // 目标 DOM 元素
  offset: ScrollPositionCoordinates // 偏移配置（top/left 偏移量 + 滚动行为）
): _ScrollPositionNormalized {
  // window.scrollTo 接收的是「相对于文档的绝对坐标」
  // element.getBoundingClientRect() 返回的是「相对于视口的相对坐标」

  // 获取文档根元素（html）相对于视口的位置
  const docRect = document.documentElement.getBoundingClientRect()
  // 获取目标元素相对于视口的位置
  const elRect = el.getBoundingClientRect()

  return {
    behavior: offset.behavior, // 透传平滑滚动配置（如 'smooth'）
    // 元素视口左坐标 - 文档视口左坐标 - 自定义左偏移 → 文档绝对左坐标
    left: elRect.left - docRect.left - (offset.left || 0),
    // 元素视口上坐标 - 文档视口上坐标 - 自定义上偏移 → 文档绝对上坐标
    top: elRect.top - docRect.top - (offset.top || 0),
  }
}

export const computeScrollPosition = (): _ScrollPositionNormalized => ({
  left: window.scrollX, // 当前窗口水平滚动位置
  top: window.scrollY, // 当前窗口垂直滚动位置
})

export function scrollToPosition(position: ScrollPosition): void {
  let scrollToOptions: ScrollPositionCoordinates

  // 元素锚点型（包含 el 字段）
  if ('el' in position) {
    const positionEl = position.el
    const isIdSelector =
      typeof positionEl === 'string' && positionEl.startsWith('#')
    /**
     * `id`s can accept pretty much any characters, including CSS combinators
     * like `>` or `~`. It's still possible to retrieve elements using
     * `document.getElementById('~')` but it needs to be escaped when using
     * `document.querySelector('#\\~')` for it to be valid. The only
     * requirements for `id`s are them to be unique on the page and to not be
     * empty (`id=""`). Because of that, when passing an id selector, it should
     * be properly escaped for it to work with `querySelector`. We could check
     * for the id selector to be simple (no CSS combinators `+ >~`) but that
     * would make things inconsistent since they are valid characters for an
     * `id` but would need to be escaped when using `querySelector`, breaking
     * their usage and ending up in no selector returned. Selectors need to be
     * escaped:
     *
     * - `#1-thing` becomes `#\31 -thing`
     * - `#with~symbols` becomes `#with\\~symbols`
     *
     * - More information about  the topic can be found at
     *   https://mathiasbynens.be/notes/html5-id-class.
     * - Practical example: https://mathiasbynens.be/demo/html5-id
     */
    if (__DEV__ && typeof position.el === 'string') {
      // 场景1：是 ID 选择器但对应元素不存在，或不是 ID 选择器
      if (!isIdSelector || !document.getElementById(position.el.slice(1))) {
        try {
          const foundEl = document.querySelector(position.el)
          // 场景1.1：是 ID 选择器但通过 querySelector 找到了元素 → 警告（建议用 getElementById）
          if (isIdSelector && foundEl) {
            warn(
              `The selector "${position.el}" should be passed as "el: document.querySelector('${position.el}')" because it starts with "#".`
            )
            // return to avoid other warnings
            return
          }
        } catch (err) {
          // 场景1.2：选择器语法错误 → 警告（提示转义字符）
          warn(
            `The selector "${position.el}" is invalid. If you are using an id selector, make sure to escape it. You can find more information about escaping characters in selectors at https://mathiasbynens.be/notes/css-escapes or use CSS.escape (https://developer.mozilla.org/en-US/docs/Web/API/CSS/escape).`
          )
          // return to avoid other warnings
          return
        }
      }
    }

    // 查找目标 DOM 元素
    const el =
      typeof positionEl === 'string'
        ? isIdSelector
          ? document.getElementById(positionEl.slice(1)) // ID 选择器：直接用 getElementById
          : document.querySelector(positionEl) // 其他选择器：用 querySelector
        : positionEl // 非字符串：直接使用传入的 HTMLElement

    // 元素不存在 → 开发环境警告并返回
    if (!el) {
      __DEV__ &&
        warn(
          `Couldn't find element using selector "${position.el}" returned by scrollBehavior.`
        )
      return
    }
    // 计算元素的滚动坐标
    scrollToOptions = getElementPosition(el, position)

    // 坐标型（直接使用）
  } else {
    scrollToOptions = position
  }

  // 浏览器支持平滑滚动（scrollBehavior API）
  // 判断浏览器是否支持 window.scrollTo 的配置项（如 { behavior: 'smooth' }）
  if ('scrollBehavior' in document.documentElement.style)
    window.scrollTo(scrollToOptions)

  // 不支持平滑滚动 → 降级使用基础 scrollTo
  else {
    window.scrollTo(
      scrollToOptions.left != null ? scrollToOptions.left : window.scrollX,
      scrollToOptions.top != null ? scrollToOptions.top : window.scrollY
    )
  }
}

export function getScrollKey(path: string, delta: number): string {
  const position: number = history.state ? history.state.position - delta : -1
  // 生成唯一 key：结合「历史记录的位置索引」+「路由路径」，避免冲突
  return position + path
}

// 存储已保存的滚动位置（key: 滚动位置键，value: 滚动位置坐标）
export const scrollPositions = new Map<string, _ScrollPositionNormalized>()

// 保存滚动位置
export function saveScrollPosition(
  key: string,
  scrollPosition: _ScrollPositionNormalized
) {
  scrollPositions.set(key, scrollPosition)
}

export function getSavedScrollPosition(key: string) {
  // 获取滚动位置
  const scroll = scrollPositions.get(key)
  // consume it so it's not used again
  scrollPositions.delete(key) // 删除已使用的滚动位置，避免重复使用
  return scroll
}

// TODO: RFC about how to save scroll position
/**
 * ScrollBehavior instance used by the router to compute and restore the scroll
 * position when navigating.
 */
// export interface ScrollHandler<ScrollPositionEntry extends HistoryStateValue, ScrollPosition extends ScrollPositionEntry> {
//   // returns a scroll position that can be saved in history
//   compute(): ScrollPositionEntry
//   // can take an extended ScrollPositionEntry
//   scroll(position: ScrollPosition): void
// }

// export const scrollHandler: ScrollHandler<ScrollPosition> = {
//   compute: computeScroll,
//   scroll: scrollToPosition,
// }
