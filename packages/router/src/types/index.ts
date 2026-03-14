import type { LocationQuery, LocationQueryRaw } from '../query'
import type { PathParserOptions } from '../matcher'
import type { Ref, Component, DefineComponent } from 'vue'
import type { RouteRecord, RouteRecordNormalized } from '../matcher/types'
import type { HistoryState } from '../history/common'
import type {
  NavigationGuardWithThis,
  RouteLocation,
  RouteRecordRedirectOption,
  _RouteRecordProps,
  RouteRecordNameGeneric,
} from '../typed-routes'
import type { _Awaitable } from './utils'

export type Lazy<T> = () => Promise<T>
export type Override<T, U> = Pick<T, Exclude<keyof T, keyof U>> & U

// TODO: find a better way to type readonly types. Readonly<T> is non recursive, maybe we should use it at multiple places. It would also allow preventing the problem Immutable create.
export type Immutable<T> = {
  readonly [P in keyof T]: Immutable<T[P]>
}

/**
 * Type to transform a static object into one that allows passing Refs as
 * values.
 * @internal
 */
export type VueUseOptions<T> = {
  [k in keyof T]: Ref<T[k]> | T[k]
}

export type TODO = any

/**
 * @internal
 */
export type RouteParamValue = string
/**
 * @internal
 */
export type RouteParamValueRaw = RouteParamValue | number | null | undefined
export type RouteParamsGeneric = Record<
  string,
  RouteParamValue | RouteParamValue[]
>
export type RouteParamsRawGeneric = Record<
  string,
  RouteParamValueRaw | Exclude<RouteParamValueRaw, null | undefined>[]
>

/**
 * @internal
 */
export interface RouteQueryAndHash {
  query?: LocationQueryRaw
  hash?: string
}

/**
 * @internal
 */
export interface MatcherLocationAsPath {
  path: string
}

/**
 * @internal
 */
export interface MatcherLocationAsName {
  name: RouteRecordNameGeneric
  // to allow checking location.path == null
  /**
   * Ignored path property since we are dealing with a relative location. Only `undefined` is allowed.
   */
  path?: undefined
  params?: RouteParamsGeneric
}

/**
 * @internal
 */
export interface MatcherLocationAsRelative {
  // to allow checking location.path == null
  /**
   * Ignored path property since we are dealing with a relative location. Only `undefined` is allowed.
   */
  path?: undefined
  params?: RouteParamsGeneric
}

/**
 * @internal
 */
export interface LocationAsRelativeRaw {
  name?: RouteRecordNameGeneric
  // to allow checking location.path == null
  /**
   * Ignored path property since we are dealing with a relative location. Only `undefined` is allowed.
   */
  path?: undefined
  params?: RouteParamsRawGeneric
}

/**
 * Common options for all navigation methods.
 */
export interface RouteLocationOptions {
  /**
   * Replace the entry in the history instead of pushing a new entry
   */
  replace?: boolean
  /**
   * Triggers the navigation even if the location is the same as the current one.
   * Note this will also add a new entry to the history unless `replace: true`
   * is passed.
   */
  force?: boolean
  /**
   * State to save using the History API. This cannot contain any reactive
   * values and some primitives like Symbols are forbidden. More info at
   * https://developer.mozilla.org/en-US/docs/Web/API/History/state
   */
  state?: HistoryState
}

/**
 * Route Location that can infer the necessary params based on the name.
 *
 * @internal
 */
export interface RouteLocationNamedRaw
  extends RouteQueryAndHash, LocationAsRelativeRaw, RouteLocationOptions {}

/**
 * Route Location that can infer the possible paths.
 *
 * @internal
 */
export interface RouteLocationPathRaw
  extends RouteQueryAndHash, MatcherLocationAsPath, RouteLocationOptions {}

// TODO: rename in next major to RouteRecordMatched?
export interface RouteLocationMatched extends RouteRecordNormalized {
  // components cannot be Lazy<RouteComponent>
  components: Record<string, RouteComponent> | null | undefined
}

/**
 * Base properties for a normalized route location.
 *
 * @internal
 */
export interface _RouteLocationBase extends Pick<
  MatcherLocation,
  'name' | 'path' | 'params' | 'meta'
> {
  /**
   * The whole location including the `search` and `hash`. This string is
   * percentage encoded.
   */
  fullPath: string
  /**
   * Object representation of the `search` property of the current location.
   */
  query: LocationQuery
  /**
   * Hash of the current location. If present, starts with a `#`.
   */
  hash: string
  /**
   * Contains the location we were initially trying to access before ending up
   * on the current location.
   */
  redirectedFrom: RouteLocation | undefined
}

/**
 * Allowed Component in {@link RouteLocationMatched}
 */
export type RouteComponent = Component | DefineComponent
/**
 * Allowed Component definitions in route records provided by the user
 * RawRouteComponent 兼容多种组件形式：
    1、直接导入的组件：import Home from './Home.vue'；
    2、异步组件：() => import('./Home.vue')；
    3、异步组件带加载状态：defineAsyncComponent({ loader: () => import('./Home.vue') })；
 */
export type RawRouteComponent = RouteComponent | Lazy<RouteComponent>

// TODO: could this be moved to matcher? YES, it's on the way
/**
 * Internal type for common properties among all kind of {@link RouteRecordRaw}.
 */
export interface _RouteRecordBase extends PathParserOptions {
  /**
   * Path of the record. Should start with `/` unless the record is the child of
   * another record.
   * 路由路径
   * @example `/users/:id` matches `/users/1` as well as `/users/posva`.
   */
  path: string

  /**
   * Where to redirect if the route is directly matched. The redirection happens
   * before any navigation guard and triggers a new navigation with the new
   * target location.
   */
  redirect?: RouteRecordRedirectOption

  /**
   * Aliases for the record. Allows defining extra paths that will behave like a
   * copy of the record. Allows having paths shorthands like `/users/:id` and
   * `/u/:id`. All `alias` and `path` values must share the same params.
   */
  alias?: string | string[]

  /**
   * Name for the route record. Must be unique.
   */
  name?: RouteRecordNameGeneric

  /**
   * Before Enter guard specific to this record. Note `beforeEnter` has no
   * effect if the record has a `redirect` property.
   */
  beforeEnter?:
    | NavigationGuardWithThis<undefined>
    | NavigationGuardWithThis<undefined>[]

  /**
   * Arbitrary data attached to the record.
   */
  meta?: RouteMeta

  /**
   * Array of nested routes.
   */
  children?: RouteRecordRaw[]

  /**
   * Allow passing down params as props to the component rendered by `router-view`.
   */
  props?: _RouteRecordProps | Record<string, _RouteRecordProps>
}

/**
 * Interface to type `meta` fields in route records.
 *
 * @example
 *
 * ```ts
 * // typings.d.ts or router.ts
 * import 'vue-router';
 *
 * declare module 'vue-router' {
 *   interface RouteMeta {
 *     requiresAuth?: boolean
 *   }
 * }
 * ```
 */
export interface RouteMeta extends Record<PropertyKey, unknown> {}

/**
 * Route Record defining one single component with the `component` option.
 */
export interface RouteRecordSingleView extends _RouteRecordBase {
  /**
   * Component to display when the URL matches this route.
   * 指定路由匹配时要渲染的单个组件，是单视图路由的核心标识
   */
  component: RawRouteComponent
  // 明确禁止在单视图路由中使用 components 字段（多视图路由的核心字段）
  components?: never
  // 明确禁止在单视图路由中使用 children 字段（嵌套路由的核心字段）
  children?: never
  // 明确禁止在单视图路由中使用 redirect 字段（重定向路由的核心字段）
  redirect?: never

  /**
   * Allow passing down params as props to the component rendered by `router-view`.
   * 控制是否将路由参数（params/query）作为 props 传递给路由组件，避免组件直接依赖 $route
   */
  props?: _RouteRecordProps
}

/**
 * Route Record defining one single component with a nested view. Differently
 * from {@link RouteRecordSingleView}, this record has children and allows a
 * `redirect` option.
 */
export interface RouteRecordSingleViewWithChildren extends _RouteRecordBase {
  /**
   * Component to display when the URL matches this route.
   * 指定父路由匹配时渲染的布局组件（需包含 <RouterView> 用于渲染子路由）
   */
  component?: RawRouteComponent | null | undefined
  // 与 RouteRecordSingleView 一致，禁止使用 components（多视图字段），保证父路由为「单视图布局」
  components?: never

  // 定义父路由下的嵌套子路由，是该接口的核心标识（区别于 RouteRecordSingleView）
  children: RouteRecordRaw[]

  /**
   * Allow passing down params as props to the component rendered by `router-view`.
   * 控制是否将父路由的参数传递给父布局组件（而非子路由组件）
   */
  props?: _RouteRecordProps
}

/**
 * Route Record defining multiple named components with the `components` option.
 */
export interface RouteRecordMultipleViews extends _RouteRecordBase {
  /**
   * Components to display when the URL matches this route. Allow using named views.
   * 指定路由匹配时要渲染的多个命名组件，键为「视图名称」，值为「组件」，是多视图路由的核心标识
   * 示例  components: {
            default: () => import('./DashboardMain.vue'), // 对应 <RouterView>（默认视图）
            header: () => import('./DashboardHeader.vue'), // 对应 <RouterView name="header">
            sidebar: () => import('./DashboardSidebar.vue'), // 对应 <RouterView name="sidebar">
          },
   */
  components: Record<string, RawRouteComponent>
  component?: never // 明确禁止使用 component 字段（单视图路由的核心字段）
  // 禁止使用 children 字段，多视图 + 嵌套子路由需使用 RouteRecordMultipleViewsWithChildren 类型
  children?: never
  // 禁止使用 redirect 字段，重定向路由需使用 RouteRecordRedirect 类型
  redirect?: never

  /**
   * Allow passing down params as props to the component rendered by
   * `router-view`. Should be an object with the same keys as `components` or a
   * boolean to be applied to every component.
   * 控制是否将路由参数传递给每个命名视图组件，是单视图 props 字段的多视图扩展
   */
  props?: Record<string, _RouteRecordProps> | boolean
}

/**
 * Route Record defining multiple named components with the `components` option and children.
 */
export interface RouteRecordMultipleViewsWithChildren extends _RouteRecordBase {
  /**
   * Components to display when the URL matches this route. Allow using named views.
   * 指定父路由匹配时渲染的多命名视图布局组件（需包含多个 <RouterView name="xxx"> 用于渲染子路由）；
   * 1、有布局组件：父路由渲染多视图布局（如 header + sidebar + main），子路由可覆盖 / 扩展父视图；
   * 2、无布局组件：父路由仅用于路径分组（如 /admin/* 下的多视图子路由，无可视化布局）；
   */
  components?: Record<string, RawRouteComponent> | null | undefined
  // 与 RouteRecordMultipleViews 一致，禁止使用 component 字段（单视图路由的核心字段）
  component?: never

  // 定义父多视图路由下的嵌套子路由，是该接口的核心标识（区别于 RouteRecordMultipleViews）
  children: RouteRecordRaw[]

  /**
   * Allow passing down params as props to the component rendered by
   * `router-view`. Should be an object with the same keys as `components` or a
   * boolean to be applied to every component.
   * 控制是否将父路由的参数传递给父多视图组件（而非子路由组件）
   */
  props?: Record<string, _RouteRecordProps> | boolean
}

/**
 * Route Record that defines a redirect. Cannot have `component` or `components`
 * as it is never rendered.
 */
export interface RouteRecordRedirect extends _RouteRecordBase {
  // 指定当前路径匹配后要跳转到的目标路由，是重定向路由的唯一核心标识；
  redirect: RouteRecordRedirectOption
  // 明确禁止使用 component 字段（单视图路由的核心字段）；
  component?: never
  // 禁止使用 components 字段（多视图路由的核心字段）
  components?: never
  // 禁止使用 props 字段（组件参数传递配置）
  // props 仅用于「组件接收路由参数」，而重定向路由无组件渲染，传参配置无意义
  props?: never
}

export type RouteRecordRaw =
  | RouteRecordSingleView // 最基础的路由配置，对应「一个路径匹配一个组件」的场景,无嵌套子路由
  // 基础单视图路由 + 嵌套子路由（对应 <RouterView> 嵌套渲染）
  | RouteRecordSingleViewWithChildren
  // 一个路径匹配多个组件，对应 <RouterView name="xxx"> 命名视图
  | RouteRecordMultipleViews
  // 多视图路由 + 嵌套子路由，是 RouteRecordMultipleViews 的扩展
  | RouteRecordMultipleViewsWithChildren
  // 仅用于路由重定向，无组件 / 视图配置，匹配路径后跳转到目标路由
  | RouteRecordRedirect

// make matched non-enumerable for easy printing
// NOTE: commented for tests at RouterView.spec
// Object.defineProperty(START_LOCATION_NORMALIZED, 'matched', {
//   enumerable: false,
// })

// Matcher types
// the matcher doesn't care about query and hash
/**
 * Route location that can be passed to the matcher.
 */
export type MatcherLocationRaw =
  | MatcherLocationAsPath
  | MatcherLocationAsName
  | MatcherLocationAsRelative

/**
 * Normalized/resolved Route location that returned by the matcher.
 */
export interface MatcherLocation {
  /**
   * Name of the matched record
   */
  name: RouteRecordNameGeneric | null | undefined

  /**
   * Percentage encoded pathname section of the URL.
   */
  path: string

  /**
   * Object of decoded params extracted from the `path`.
   */
  params: RouteParamsGeneric

  /**
   * Merged `meta` properties from all the matched route records.
   */
  meta: RouteMeta

  /**
   * Array of {@link RouteRecord} containing components as they were
   * passed when adding records. It can also contain redirect records. This
   * can't be used directly
   */
  matched: RouteRecord[] // non-enumerable
}

export * from './typeGuards'

export type Mutable<T> = {
  -readonly [P in keyof T]: T[P]
}
