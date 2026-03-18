import {
  RouteRecordRaw,
  Lazy,
  isRouteLocation,
  isRouteName,
  RouteLocationOptions,
  MatcherLocationRaw,
} from './types'
import type {
  RouteLocation,
  RouteLocationRaw,
  RouteParams,
  RouteLocationNormalized,
  RouteLocationNormalizedLoaded,
  NavigationGuardWithThis,
  NavigationHookAfter,
  RouteLocationResolved,
  RouteRecordNameGeneric,
} from './typed-routes'
import { HistoryState, NavigationType } from './history/common'
import {
  getSavedScrollPosition,
  getScrollKey,
  saveScrollPosition,
  computeScrollPosition,
  scrollToPosition,
  _ScrollPositionNormalized,
} from './scrollBehavior'
import { createRouterMatcher } from './matcher'
import {
  createRouterError,
  ErrorTypes,
  NavigationFailure,
  NavigationRedirectError,
  isNavigationFailure,
  _ErrorListener,
} from './errors'
import { applyToParams, isBrowser, assign, noop, isArray } from './utils'
import { useCallbacks } from './utils/callbacks'
import { encodeParam, decode, encodeHash } from './encoding'
import {
  normalizeQuery,
  parseQuery as originalParseQuery,
  stringifyQuery as originalStringifyQuery,
  LocationQuery,
} from './query'
import { shallowRef, nextTick, App, unref, shallowReactive } from 'vue'
import { RouteRecordNormalized } from './matcher/types'
import {
  parseURL,
  stringifyURL,
  isSameRouteLocation,
  START_LOCATION_NORMALIZED,
} from './location'
import {
  extractChangingRecords,
  extractComponentsGuards,
  guardToPromiseFn,
} from './navigationGuards'
import { warn } from './warning'
import { RouterLink } from './RouterLink'
import { RouterView } from './RouterView'
import {
  routeLocationKey,
  routerKey,
  routerViewLocationKey,
} from './injectionSymbols'
import { addDevtools } from './devtools'
import { _LiteralUnion } from './types/utils'
import {
  EXPERIMENTAL_RouterOptions_Base,
  EXPERIMENTAL_Router_Base,
  _OnReadyCallback,
} from './experimental/router'

/**
 * Options to initialize a {@link Router} instance.
 */
export interface RouterOptions extends EXPERIMENTAL_RouterOptions_Base {
  /**
   * Initial list of routes that should be added to the router.
   */
  routes: Readonly<RouteRecordRaw[]>
}

/**
 * Router instance.
 * 路由实例
 */
export interface Router extends EXPERIMENTAL_Router_Base<RouteRecordNormalized> {
  /**
   * Original options object passed to create the Router
   * 存储创建路由实例时传入的原始配置项
   */
  readonly options: RouterOptions

  /**
   * Add a new {@link RouteRecordRaw | route record} as the child of an existing route.
   * 动态路由方法
   * 重载 1：添加嵌套路由
   * 返回值：一个「移除该动态路由的函数」，调用后可删除本次添加的路由
   * @param parentName - Parent Route Record where `route` should be appended at
   * @param route - Route Record to add
   */
  addRoute(
    // NOTE: it could be `keyof RouteMap` but the point of dynamic routes is not knowing the routes at build
    parentName: NonNullable<RouteRecordNameGeneric>,
    route: RouteRecordRaw
  ): () => void
  /**
   * Add a new {@link RouteRecordRaw | route record} to the router.
   *
   * @param route - Route Record to add
   * 重载 2：添加顶级路由
   * 返回值：一个「移除该动态路由的函数」，调用后可删除本次添加的路由
   */
  addRoute(route: RouteRecordRaw): () => void

  /**
   * Remove an existing route by its name.
   *
   * @param name - Name of the route to remove 路由名称（非空），注意只能通过名称删除，不能通过路径
   * 根据路由名称删除已存在的路由（包括静态路由和动态添加的路由）
   *
   */
  removeRoute(name: NonNullable<RouteRecordNameGeneric>): void

  /**
   * Delete all routes from the router.
   * 清空路由表中所有路由（包括静态路由和动态添加的路由）
   * 注意：清空后路由表为空，需重新调用 addRoute 添加路由，否则导航会失效
   */
  clearRoutes(): void
}

/**
 * Creates a Router instance that can be used by a Vue app.
 * 负责组装路由的所有核心能力（路由匹配、导航守卫、历史记录管理、滚动行为、URL 解析 / 生成等），
 * 最终返回一个可安装到 Vue 应用的 Router 实例
 * @param options - {@link RouterOptions}
 */
export function createRouter(options: RouterOptions): Router {
  // 创建路由匹配器：解析 routes 配置，生成匹配规则（核心）
  const matcher = createRouterMatcher(options.routes, options)

  // 初始化 URL 查询参数解析/序列化函数（默认/自定义）
  const parseQuery = options.parseQuery || originalParseQuery
  const stringifyQuery = options.stringifyQuery || originalStringifyQuery

  // 初始化历史管理器（Hash/History 模式），开发环境校验必传
  const routerHistory = options.history

  if (__DEV__ && !routerHistory)
    throw new Error(
      'Provide the "history" option when calling "createRouter()":' +
        ' https://router.vuejs.org/api/interfaces/RouterOptions.html#history'
    )

  // 初始化导航守卫队列（全局前置/解析后/后置守卫）
  const beforeGuards = useCallbacks<NavigationGuardWithThis<undefined>>()
  const beforeResolveGuards = useCallbacks<NavigationGuardWithThis<undefined>>()
  const afterGuards = useCallbacks<NavigationHookAfter>()

  // 初始化当前路由（响应式）和待处理路由
  const currentRoute = shallowRef<RouteLocationNormalizedLoaded>(
    START_LOCATION_NORMALIZED
  )
  // 待处理路由（当前导航目标），初始值为起始路由
  let pendingLocation: RouteLocation = START_LOCATION_NORMALIZED

  // 滚动行为初始化：有自定义 scrollBehavior 时，禁用浏览器默认滚动恢复
  // leave the scrollRestoration if no scrollBehavior is provided
  if (isBrowser && options.scrollBehavior && 'scrollRestoration' in history) {
    history.scrollRestoration = 'manual'
  }

  const normalizeParams = applyToParams.bind(
    null,
    paramValue => '' + paramValue
  )
  // 遍历路由参数对象的所有值，对每个值应用指定的处理函数，并返回新的参数对象
  const encodeParams = applyToParams.bind(null, encodeParam)
  const decodeParams: (params: RouteParams | undefined) => RouteParams =
    // @ts-expect-error: intentionally avoid the type check
    applyToParams.bind(null, decode)

  /**
   * 新增路由（支持嵌套）
   * 格式 1：addRoute(父路由名称, 子路由配置)
   * 格式 2：addRoute(路由配置)
   * @param parentOrRoute 父路由记录名或路由记录对象
   * @param route 子路由记录（可选）
   * @returns 移除路由的函数
   */
  function addRoute(
    parentOrRoute: NonNullable<RouteRecordNameGeneric> | RouteRecordRaw,
    route?: RouteRecordRaw
  ) {
    let parent: Parameters<(typeof matcher)['addRoute']>[1] | undefined
    let record: RouteRecordRaw

    // 判断第一个参数是否为「路由名称」（而非路由配置对象）
    if (isRouteName(parentOrRoute)) {
      // 根据路由名称从底层匹配器中获取对应的「路由记录匹配器」
      parent = matcher.getRecordMatcher(parentOrRoute)
      if (__DEV__ && !parent) {
        warn(
          `Parent route "${String(parentOrRoute)}" not found when adding child route`,
          route
        )
      }
      record = route!
    } else {
      record = parentOrRoute
    }

    return matcher.addRoute(record, parent)
  }

  /**
   * 删除路由（根据路由记录名）
   * @param name 路由记录名
   */
  function removeRoute(name: NonNullable<RouteRecordNameGeneric>) {
    const recordMatcher = matcher.getRecordMatcher(name)
    if (recordMatcher) {
      matcher.removeRoute(recordMatcher)
    } else if (__DEV__) {
      warn(`Cannot remove non-existent route "${String(name)}"`)
    }
  }

  /**
   * 获取所有路由记录
   * @returns
   */
  function getRoutes() {
    return matcher.getRoutes().map(routeMatcher => routeMatcher.record)
  }

  /**
   * 判断路由是否存在
   * @param name
   * @returns
   */
  function hasRoute(name: NonNullable<RouteRecordNameGeneric>): boolean {
    return !!matcher.getRecordMatcher(name)
  }

  /**
   * 路由地址解析器
   * @param rawLocation 原始路由地址（字符串或对象）
   * @param currentLocation 当前路由状态（可选）
   * @returns 解析后的路由地址对象
   */
  function resolve(
    rawLocation: RouteLocationRaw,
    currentLocation?: RouteLocationNormalizedLoaded
  ): RouteLocationResolved {
    // const resolve: Router['resolve'] = (rawLocation: RouteLocationRaw, currentLocation) => {
    // const objectLocation = routerLocationAsObject(rawLocation)
    // we create a copy to modify it later
    currentLocation = assign({}, currentLocation || currentRoute.value)

    // 解析字符串路由地址（包含 query/hash）
    if (typeof rawLocation === 'string') {
      const locationNormalized = parseURL(
        parseQuery,
        rawLocation,
        currentLocation.path
      )
      const matchedRoute = matcher.resolve(
        { path: locationNormalized.path },
        currentLocation
      )

      const href = routerHistory.createHref(locationNormalized.fullPath)
      if (__DEV__) {
        if (href.startsWith('//'))
          warn(
            `Location "${rawLocation}" resolved to "${href}". A resolved location cannot start with multiple slashes.`
          )
        else if (!matchedRoute.matched.length) {
          warn(`No match found for location with path "${rawLocation}"`)
        }
      }

      // locationNormalized is always a new object
      return assign(locationNormalized, matchedRoute, {
        params: decodeParams(matchedRoute.params),
        hash: decode(locationNormalized.hash),
        redirectedFrom: undefined,
        href,
      })
    }

    // 校验 rawLocation 是否为合法的路由对象（包含 path/name 至少其一）
    if (__DEV__ && !isRouteLocation(rawLocation)) {
      warn(
        `router.resolve() was passed an invalid location. This will fail in production.\n- Location:`,
        rawLocation
      )
      return resolve({})
    }

    let matcherLocation: MatcherLocationRaw

    // path could be relative in object as well
    // 解析对象路由地址（包含 path/params/query/hash）
    // 含 path 的对象路由
    if (rawLocation.path != null) {
      // 开发环境警告：path 与 params 混用（params 会被忽略）
      // path 与 params 不兼容：通过 path 跳转时，params 会被忽略（因 path 已包含参数，如 /user/1）
      if (
        __DEV__ &&
        'params' in rawLocation &&
        !('name' in rawLocation) &&
        // @ts-expect-error: the type is never
        Object.keys(rawLocation.params).length
      ) {
        warn(
          `Path "${rawLocation.path}" was passed with params but they will be ignored. Use a named route alongside params instead.`
        )
      }
      matcherLocation = assign({}, rawLocation, {
        path: parseURL(parseQuery, rawLocation.path, currentLocation.path).path,
      })

      // 解析命名路由地址（包含 name/params）
    } else {
      // remove any nullish param
      const targetParams = assign({}, rawLocation.params)
      for (const key in targetParams) {
        // 移除 null/undefined 的 params（避免匹配错误）
        if (targetParams[key] == null) {
          delete targetParams[key]
        }
      }
      // pass encoded values to the matcher, so it can produce encoded path and fullPath
      matcherLocation = assign({}, rawLocation, {
        params: encodeParams(targetParams),
      })
      // current location params are decoded, we need to encode them in case the
      // matcher merges the params
      currentLocation.params = encodeParams(currentLocation.params)
    }

    const matchedRoute = matcher.resolve(matcherLocation, currentLocation)
    const hash = rawLocation.hash || ''

    // 开发环境警告：hash 未以 # 开头
    if (__DEV__ && hash && !hash.startsWith('#')) {
      warn(
        `A \`hash\` should always start with the character "#". Replace "${hash}" with "#${hash}".`
      )
    }

    // the matcher might have merged current location params, so
    // we need to run the decoding again
    matchedRoute.params = normalizeParams(decodeParams(matchedRoute.params))

    // 生成 fullPath（合并 path/query/hash）
    const fullPath = stringifyURL(
      stringifyQuery,
      assign({}, rawLocation, {
        hash: encodeHash(hash),
        path: matchedRoute.path,
      })
    )

    const href = routerHistory.createHref(fullPath)
    if (__DEV__) {
      if (href.startsWith('//')) {
        warn(
          `Location "${rawLocation}" resolved to "${href}". A resolved location cannot start with multiple slashes.`
        )
      } else if (!matchedRoute.matched.length) {
        warn(
          `No match found for location with path "${
            rawLocation.path != null ? rawLocation.path : rawLocation
          }"`
        )
      }
    }

    return assign(
      {
        fullPath,
        // keep the hash encoded so fullPath is effectively path + encodedQuery +
        // hash
        hash,
        query:
          // if the user is using a custom query lib like qs, we might have
          // nested objects, so we keep the query as is, meaning it can contain
          // numbers at `$route.query`, but at the point, the user will have to
          // use their own type anyway.
          // https://github.com/vuejs/router/issues/328#issuecomment-649481567
          stringifyQuery === originalStringifyQuery
            ? normalizeQuery(rawLocation.query)
            : ((rawLocation.query || {}) as LocationQuery),
      },
      matchedRoute,
      {
        redirectedFrom: undefined,
        href,
      }
    )
  }

  function locationAsObject(
    to: RouteLocationRaw | RouteLocationNormalized
  ): Exclude<RouteLocationRaw, string> | RouteLocationNormalized {
    return typeof to === 'string'
      ? parseURL(parseQuery, to, currentRoute.value.path)
      : assign({}, to)
  }

  function checkCanceledNavigation(
    to: RouteLocationNormalized,
    from: RouteLocationNormalized
  ): NavigationFailure | void {
    // 全局挂起的路由 ≠ 当前待完成的路由
    // 说明有新的导航请求，当前导航应被取消
    if (pendingLocation !== to) {
      // 创建并返回「导航取消」类型的失败错误
      return createRouterError<NavigationFailure>(
        ErrorTypes.NAVIGATION_CANCELLED,
        {
          from,
          to,
        }
      )
    }
  }

  function push(to: RouteLocationRaw) {
    return pushWithRedirect(to)
  }

  function replace(to: RouteLocationRaw) {
    return push(assign(locationAsObject(to), { replace: true }))
  }

  /**
   * 「解析目标路由匹配记录中最后一条的 redirect 配置
   *  →标准化重定向目标格式→校验重定向合法性→合并原路由的 query/hash 等参数→返回最终的重定向目标」
   * @param to 目标路由对象
   * @param from 来源路由对象
   * @returns
   */
  function handleRedirectRecord(
    to: RouteLocation,
    from: RouteLocationNormalizedLoaded
  ): RouteLocationRaw | void {
    const lastMatched = to.matched[to.matched.length - 1] // 获取最后一条匹配记录

    if (lastMatched && lastMatched.redirect) {
      const { redirect } = lastMatched // 获取 redirect 配置

      // 解析 redirect，目标重定向位置
      let newTargetLocation =
        typeof redirect === 'function' ? redirect(to, from) : redirect

      // 标准化字符串格式的 redirect → 对象格式
      if (typeof newTargetLocation === 'string') {
        newTargetLocation =
          // 字符串含 ?/# → 解析为完整对象（包含 query/hash）
          newTargetLocation.includes('?') || newTargetLocation.includes('#')
            ? (newTargetLocation = locationAsObject(newTargetLocation))
            : // force empty params
              { path: newTargetLocation }

        // @ts-expect-error: force empty params when a string is passed to let
        // the router parse them again
        // 强制清空 params，避免原路由 params 污染重定向目标
        newTargetLocation.params = {}
      }

      if (
        __DEV__ &&
        newTargetLocation.path == null &&
        !('name' in newTargetLocation)
      ) {
        warn(
          `Invalid redirect found:\n${JSON.stringify(
            newTargetLocation,
            null,
            2
          )}\n when navigating to "${
            to.fullPath
          }". A redirect must contain a name or path. This will break in production.`
        )
        throw new Error('Invalid redirect')
      }

      return assign(
        {
          query: to.query, // 继承原路由的 query 参数
          hash: to.hash, // 继承原路由的 hash 锚点
          // avoid transferring params if the redirect has a path
          // 重定向目标有 path → 清空 params；无 path（用 name 跳转）→ 继承原 params
          params: newTargetLocation.path != null ? {} : to.params,
        },
        newTargetLocation
      )
    }
  }

  /**
   * 负责处理「路由跳转 + 重定向 + 守卫执行 + 历史记录更新 + 错误处理」的全流程
   * @param to 目标路由位置（可以是字符串路径、命名路由对象或路径对象）
   * @param redirectedFrom 重定向来源路由位置（可选）
   * @returns 导航失败原因、成功时无返回值或 undefined
   */
  function pushWithRedirect(
    to: RouteLocationRaw | RouteLocation,
    redirectedFrom?: RouteLocation
  ): Promise<NavigationFailure | void | undefined> {
    // 解析目标路由为标准化 RouteLocation 对象
    const targetLocation: RouteLocation = (pendingLocation = resolve(to))
    const from = currentRoute.value // 获取当前路由（响应式的 currentRoute）

    // 获取历史记录状态（state）
    const data: HistoryState | undefined = (to as RouteLocationOptions).state
    // 获取强制跳转标志（force）
    const force: boolean | undefined = (to as RouteLocationOptions).force
    // to could be a string where `replace` is a function
    // 获取替换标志（replace）
    const replace = (to as RouteLocationOptions).replace === true

    // 检查目标路由是否配置了 redirect，返回重定向后的路由
    const shouldRedirect = handleRedirectRecord(targetLocation, from)

    // 若存在重定向，递归调用 pushWithRedirect 处理重定向后的路由
    if (shouldRedirect)
      return pushWithRedirect(
        // 合并重定向路由与原配置
        assign(locationAsObject(shouldRedirect), {
          state:
            typeof shouldRedirect === 'object'
              ? assign({}, data, shouldRedirect.state)
              : data,
          force,
          replace,
        }),
        // keep original redirectedFrom if it exists
        redirectedFrom || targetLocation
      )

    // if it was a redirect we already called `pushWithRedirect` above
    const toLocation = targetLocation as RouteLocationNormalized // 标准化目标路由

    toLocation.redirectedFrom = redirectedFrom // 标记重定向来源

    let failure: NavigationFailure | void | undefined // 声明导航失败变量

    // 非强制跳转 + 路由完全相同 → 生成重复跳转错误
    if (!force && isSameRouteLocation(stringifyQuery, from, targetLocation)) {
      failure = createRouterError<NavigationFailure>(
        ErrorTypes.NAVIGATION_DUPLICATED,
        {
          to: toLocation,
          from,
        }
      )
      // trigger scroll to allow scrolling to the same anchor
      // 即使重复跳转，仍处理滚动（如锚点 #top）
      handleScroll(
        from,
        from,
        // this is a push, the only way for it to be triggered from a
        // history.listen is with a redirect, which makes it become a push
        true, // push导航
        // This cannot be the first navigation because the initial location
        // cannot be manually navigated to
        false // 非首次导航，初始路由不能手动跳转
      )
    }

    // 有失败则返回 resolved 的 failure，否则调用 navigate 执行真正的导航
    return (failure ? Promise.resolve(failure) : navigate(toLocation, from))

      .catch((error: NavigationFailure | NavigationRedirectError) =>
        isNavigationFailure(error)
          ? // navigation redirects still mark the router as ready
            isNavigationFailure(error, ErrorTypes.NAVIGATION_GUARD_REDIRECT)
            ? error // 导航守卫重定向 → 仅返回错误
            : // 其他导航失败
              markAsReady(error) // also returns the error
          : // reject any unknown error
            // 未知错误 → 触发全局错误并抛出
            triggerError(error, toLocation, from)
      )
      .then((failure: NavigationFailure | NavigationRedirectError | void) => {
        if (failure) {
          if (
            isNavigationFailure(failure, ErrorTypes.NAVIGATION_GUARD_REDIRECT)
          ) {
            if (
              __DEV__ &&
              // we are redirecting to the same location we were already at
              // 开发环境：检测无限重定向（超过30次）并报警
              isSameRouteLocation(
                stringifyQuery,
                resolve(failure.to),
                toLocation
              ) &&
              // and we have done it a couple of times
              redirectedFrom &&
              // @ts-expect-error: added only in dev
              (redirectedFrom._count = redirectedFrom._count
                ? // @ts-expect-error
                  redirectedFrom._count + 1
                : 1) > 30
            ) {
              warn(
                `Detected a possibly infinite redirection in a navigation guard when going from "${from.fullPath}" to "${toLocation.fullPath}". Aborting to avoid a Stack Overflow.\n Are you always returning a new location within a navigation guard? That would lead to this error. Only return when redirecting or aborting, that should fix this. This might break in production if not fixed.`
              )
              return Promise.reject(
                new Error('Infinite redirect in navigation guard')
              )
            }

            return pushWithRedirect(
              // keep options
              assign(
                {
                  // preserve an existing replacement but allow the redirect to override it
                  replace,
                },
                locationAsObject(failure.to),
                {
                  state:
                    typeof failure.to === 'object'
                      ? assign({}, data, failure.to.state)
                      : data,
                  force,
                }
              ),
              // preserve the original redirectedFrom if any
              redirectedFrom || toLocation
            )
          }
        } else {
          // if we fail we don't finalize the navigation
          // 导航成功 → 最终化导航（更新历史记录/滚动/路由状态）
          failure = finalizeNavigation(
            toLocation as RouteLocationNormalizedLoaded,
            from,
            true,
            replace,
            data
          )
        }
        // 触发 afterEach 后置钩子
        triggerAfterEach(
          toLocation as RouteLocationNormalizedLoaded,
          from,
          failure
        )
        return failure
      })
  }

  /**
   * Helper to reject and skip all navigation guards if a new navigation happened
   * @param to
   * @param from
   */
  function checkCanceledNavigationAndReject(
    to: RouteLocationNormalized,
    from: RouteLocationNormalized
  ): Promise<void> {
    const error = checkCanceledNavigation(to, from)
    // 若有取消导航错误 → 拒绝 Promise 并返回错误
    return error ? Promise.reject(error) : Promise.resolve()
  }

  function runWithContext<T>(fn: () => T): T {
    //  获取已安装的第一个 Vue 应用实例
    const app: App | undefined = installedApps.values().next().value
    // support Vue < 3.3
    // 兼容逻辑：优先用 Vue 3.3+ 的 app.runWithContext，否则直接执行函数
    return app && typeof app.runWithContext === 'function'
      ? app.runWithContext(fn)
      : fn()
  }

  // TODO: refactor the whole before guards by internally using router.beforeEach

  /**
   * 守卫执行
   * @param to 目标路由
   * @param from 当前路由
   * @returns
   */
  function navigate(
    to: RouteLocationNormalized,
    from: RouteLocationNormalizedLoaded
  ): Promise<any> {
    // 声明守卫队列变量
    let guards: Lazy<any>[]

    // 拆解路由记录（离开/更新/进入）
    const [leavingRecords, updatingRecords, enteringRecords] =
      extractChangingRecords(to, from)

    // all components here have been resolved once because we are leaving
    // 提取组件离开守卫（beforeRouteLeave）
    guards = extractComponentsGuards(
      leavingRecords.reverse(), // 反转：子组件守卫先执行，父组件后执行
      'beforeRouteLeave', // 组件离开守卫
      to,
      from
    )

    // leavingRecords is already reversed
    for (const record of leavingRecords) {
      // leaveGuards 是提前缓存的（在组件挂载 / 路由匹配时注册）
      record.leaveGuards.forEach(guard => {
        guards.push(guardToPromiseFn(guard, to, from))
      })
    }

    const canceledNavigationCheck = checkCanceledNavigationAndReject.bind(
      null,
      to,
      from
    )

    // 将校验函数加入守卫列表
    guards.push(canceledNavigationCheck)

    // run the queue of per route beforeRouteLeave guards
    //    离开守卫（beforeRouteLeave）
    //  → 全局前置（beforeEach）
    //  → 更新守卫（beforeRouteUpdate）
    //  → 路由进入（beforeEnter）
    //  → 组件进入（beforeRouteEnter）
    //  → 全局解析前（beforeResolve）
    return (
      runGuardQueue(guards)
        .then(() => {
          // check global guards beforeEach
          guards = []
          for (const guard of beforeGuards.list()) {
            guards.push(guardToPromiseFn(guard, to, from))
          }
          // 插入并发导航校验（每轮守卫前必加）
          guards.push(canceledNavigationCheck)
          return runGuardQueue(guards)
        })
        .then(() => {
          // check in components beforeRouteUpdate
          // 提取组件内 beforeRouteUpdate 守卫（复用组件的更新守卫）
          guards = extractComponentsGuards(
            updatingRecords,
            'beforeRouteUpdate',
            to,
            from
          )

          for (const record of updatingRecords) {
            record.updateGuards.forEach(guard => {
              guards.push(guardToPromiseFn(guard, to, from))
            })
          }
          // 插入并发导航校验（每轮守卫前必加）
          guards.push(canceledNavigationCheck)

          // run the queue of per route beforeEnter guards
          return runGuardQueue(guards)
        })
        .then(() => {
          // check the route beforeEnter
          guards = []
          for (const record of enteringRecords) {
            // do not trigger beforeEnter on reused views
            if (record.beforeEnter) {
              if (isArray(record.beforeEnter)) {
                for (const beforeEnter of record.beforeEnter)
                  guards.push(guardToPromiseFn(beforeEnter, to, from))
              } else {
                guards.push(guardToPromiseFn(record.beforeEnter, to, from))
              }
            }
          }
          // 插入并发导航校验（每轮守卫前必加）
          guards.push(canceledNavigationCheck)

          // run the queue of per route beforeEnter guards
          return runGuardQueue(guards)
        })
        .then(() => {
          // NOTE: at this point to.matched is normalized and does not contain any () => Promise<Component>

          // clear existing enterCallbacks, these are added by extractComponentsGuards
          // 清空之前的 enterCallbacks（避免重复执行）
          to.matched.forEach(record => (record.enterCallbacks = {}))

          // check in-component beforeRouteEnter
          guards = extractComponentsGuards(
            enteringRecords,
            'beforeRouteEnter',
            to,
            from,
            runWithContext
          )
          // 插入并发导航校验（每轮守卫前必加）
          guards.push(canceledNavigationCheck)

          // run the queue of per route beforeEnter guards
          return runGuardQueue(guards)
        })
        .then(() => {
          // check global guards beforeResolve
          guards = []
          for (const guard of beforeResolveGuards.list()) {
            guards.push(guardToPromiseFn(guard, to, from))
          }
          guards.push(canceledNavigationCheck)

          return runGuardQueue(guards)
        })
        // catch any navigation canceled
        .catch(
          err =>
            isNavigationFailure(err, ErrorTypes.NAVIGATION_CANCELLED)
              ? err // 错误会被捕获并作为导航结果返回
              : Promise.reject(err) // 继续抛出，确保错误能够被上层捕获
        )
    )
  }

  function triggerAfterEach(
    to: RouteLocationNormalizedLoaded,
    from: RouteLocationNormalizedLoaded,
    failure?: NavigationFailure | void
  ): void {
    // navigation is confirmed, call afterGuards
    // TODO: wrap with error handlers
    afterGuards
      .list()
      .forEach(guard => runWithContext(() => guard(to, from, failure)))
  }

  /**
   * - Cleans up any navigation guards
   * - Changes the url if necessary
   * - Calls the scrollBehavior
   */
  /**
   * 导航最终化
   * @param toLocation 目标路由
   * @param from 当前路由
   * @param isPush 是否为 push 导航
   * @param replace 是否为 replace 导航
   * @param data 导航状态数据
   * @returns
   */
  function finalizeNavigation(
    toLocation: RouteLocationNormalizedLoaded,
    from: RouteLocationNormalizedLoaded,
    isPush: boolean,
    replace?: boolean,
    data?: HistoryState
  ): NavigationFailure | void {
    // a more recent navigation took place
    // 校验导航是否被取消（并发导航冲突）
    const error = checkCanceledNavigation(toLocation, from)
    if (error) return error

    // only consider as push if it's not the first navigation
    // 判断是否为首次导航
    const isFirstNavigation = from === START_LOCATION_NORMALIZED
    const state: Partial<HistoryState> | null = !isBrowser ? {} : history.state

    // change URL only if the user did a push/replace and if it's not the initial navigation because
    // it's just reflecting the url
    // 仅在「主动 push 跳转」时更新 URL
    if (isPush) {
      // on the initial navigation, we want to reuse the scroll position from
      // history state if it exists
      // replace 模式 或 首次导航 → 使用 replaceState 更新 URL
      if (replace || isFirstNavigation)
        routerHistory.replace(
          toLocation.fullPath,
          assign(
            {
              scroll: isFirstNavigation && state && state.scroll,
            },
            data
          )
        )
      // 普通 push 跳转 → 使用 pushState 新增历史记录
      else routerHistory.push(toLocation.fullPath, data)
    }

    // accept current navigation
    // 更新响应式的当前路由 → 触发组件重新渲染
    currentRoute.value = toLocation
    handleScroll(toLocation, from, isPush, isFirstNavigation) // 触发滚动

    markAsReady() // 标记就绪
  }

  let removeHistoryListener: undefined | null | (() => void)
  // attach listener to history to trigger navigations
  /**
   * 历史记录监听
   * @returns
   */
  function setupListeners() {
    // avoid setting up listeners twice due to an invalid first navigation
    // 防重复注册监听
    if (removeHistoryListener) return

    // 注册历史监听
    removeHistoryListener = routerHistory.listen((to, _from, info) => {
      // 路由未处于监听状态，直接返回
      if (!router.listening) return
      // cannot be a redirect route because it was in history
      // 解析目标路由为标准化格式
      const toLocation = resolve(to) as RouteLocationNormalized

      // due to dynamic routing, and to hash history with manual navigation
      // (manually changing the url or calling history.hash = '#/somewhere'),
      // there could be a redirect record in history
      // 处理历史记录中可能存在的重定向
      const shouldRedirect = handleRedirectRecord(
        toLocation,
        router.currentRoute.value
      )
      if (shouldRedirect) {
        // 触发重定向导航（replace 模式，强制执行）
        pushWithRedirect(
          assign(shouldRedirect, { replace: true, force: true }),
          toLocation
        ).catch(noop)
        return
      }

      pendingLocation = toLocation
      const from = currentRoute.value

      // TODO: should be moved to web history?
      // 浏览器环境下，保存当前路由的滚动位置
      if (isBrowser) {
        saveScrollPosition(
          getScrollKey(from.fullPath, info.delta),
          computeScrollPosition()
        )
      }

      navigate(toLocation, from)
        .catch((error: NavigationFailure | NavigationRedirectError) => {
          // 场景1：导航被中止/取消（如守卫返回 false）→ 直接返回错误，不处理
          if (
            isNavigationFailure(
              error,
              ErrorTypes.NAVIGATION_ABORTED | ErrorTypes.NAVIGATION_CANCELLED
            )
          ) {
            return error
          }

          // 场景2：导航守卫重定向
          if (
            isNavigationFailure(error, ErrorTypes.NAVIGATION_GUARD_REDIRECT)
          ) {
            // Here we could call if (info.delta) routerHistory.go(-info.delta,
            // false) but this is bug prone as we have no way to wait the
            // navigation to be finished before calling pushWithRedirect. Using
            // a setTimeout of 16ms seems to work but there is no guarantee for
            // it to work on every browser. So instead we do not restore the
            // history entry and trigger a new navigation as requested by the
            // navigation guard.

            // the error is already handled by router.push we just want to avoid
            // logging the error
            // 触发重定向导航
            pushWithRedirect(
              assign(locationAsObject((error as NavigationRedirectError).to), {
                force: true,
              }),
              toLocation
              // avoid an uncaught rejection, let push call triggerError
            )
              .then(failure => {
                // manual change in hash history #916 ending up in the URL not
                // changing, but it was changed by the manual url change, so we
                // need to manually change it ourselves
                // 特殊场景：hash 模式手动修改 URL 导致导航失败，手动回滚历史
                if (
                  isNavigationFailure(
                    failure,
                    ErrorTypes.NAVIGATION_ABORTED |
                      ErrorTypes.NAVIGATION_DUPLICATED
                  ) &&
                  !info.delta &&
                  info.type === NavigationType.pop
                ) {
                  routerHistory.go(-1, false)
                }
              })
              .catch(noop)
            // avoid the then branch
            return Promise.reject()
          }
          // do not restore history on unknown direction
          // 场景3：未知方向的错误 → 回滚历史记录（恢复到导航前的 URL）
          if (info.delta) {
            routerHistory.go(-info.delta, false)
          }
          // unrecognized error, transfer to the global handler
          // 场景4：未识别的错误 → 触发全局错误处理
          return triggerError(error, toLocation, from)
        })
        .then((failure: NavigationFailure | void) => {
          // 完成导航收尾（更新路由状态、触发组件挂载等）
          failure =
            failure ||
            finalizeNavigation(
              // after navigation, all matched components are resolved
              toLocation as RouteLocationNormalizedLoaded,
              from,
              false
            )

          // revert the navigation
          if (failure) {
            // 有历史偏移量且非取消类失败 → 回滚 delta 步
            if (
              info.delta &&
              // a new navigation has been triggered, so we do not want to revert, that will change the current history
              // entry while a different route is displayed
              !isNavigationFailure(failure, ErrorTypes.NAVIGATION_CANCELLED)
            ) {
              routerHistory.go(-info.delta, false)

              // pop 类型导航且中止/重复 → 手动回滚 1 步（修复 hash 模式手动改 URL 问题）
            } else if (
              info.type === NavigationType.pop &&
              isNavigationFailure(
                failure,
                ErrorTypes.NAVIGATION_ABORTED | ErrorTypes.NAVIGATION_DUPLICATED
              )
            ) {
              // manual change in hash history #916
              // it's like a push but lacks the information of the direction
              routerHistory.go(-1, false)
            }
          }

          // 触发全局 afterEach 钩子
          triggerAfterEach(
            toLocation as RouteLocationNormalizedLoaded,
            from,
            failure
          )
        })
        // avoid warnings in the console about uncaught rejections, they are logged by triggerErrors
        .catch(noop)
    })
  }

  // Initialization and Errors

  // 等待就绪的回调队列（存储 [resolve, reject] 元组）
  let readyHandlers = useCallbacks<_OnReadyCallback>()
  // 全局错误监听器队列（存储错误处理函数）
  let errorListeners = useCallbacks<_ErrorListener>()
  let ready: boolean // 路由系统是否已就绪

  /**
   * Trigger errorListeners added via onError and throws the error as well
   *
   * @param error - error to throw
   * @param to - location we were navigating to when the error happened
   * @param from - location we were navigating from when the error happened
   * @returns the error as a rejected promise
   */
  function triggerError(
    error: any,
    to: RouteLocationNormalized,
    from: RouteLocationNormalizedLoaded
  ): Promise<unknown> {
    markAsReady(error)
    const list = errorListeners.list()
    if (list.length) {
      list.forEach(handler => handler(error, to, from))
    } else {
      if (__DEV__) {
        warn('uncaught error during route navigation:')
      }
      console.error(error)
    }
    // reject the error no matter there were error listeners or not
    return Promise.reject(error)
  }

  function isReady(): Promise<void> {
    // 快速返回：若路由已就绪且完成首次导航 → 直接返回成功 Promise
    if (ready && currentRoute.value !== START_LOCATION_NORMALIZED)
      return Promise.resolve()
    // 等待就绪：若路由未就绪，将回调加入队列
    return new Promise((resolve, reject) => {
      readyHandlers.add([resolve, reject])
    })
  }

  /**
   * Mark the router as ready, resolving the promised returned by isReady(). Can
   * only be called once, otherwise does nothing.
   * @param err - optional error
   */
  function markAsReady<E = any>(err: E): E
  function markAsReady<E = any>(): void
  /**
   * 标记路由系统是否完成初始化 / 就绪，并触发所有等待就绪状态的回调（成功 / 失败）
   * @param err
   * @returns
   */
  function markAsReady<E = any>(err?: E): E | void {
    // 仅首次调用生效（保证就绪状态只标记一次）
    if (!ready) {
      // still not ready if an error happened
      ready = !err // 更新就绪状态：无错误则就绪

      // 就绪后初始化事件监听器
      setupListeners()

      // 遍历所有等待就绪的回调
      readyHandlers
        .list()
        .forEach(([resolve, reject]) => (err ? reject(err) : resolve()))

      readyHandlers.reset() // 清空回调队列
    }
    return err
  }

  // Scroll behavior
  function handleScroll(
    to: RouteLocationNormalizedLoaded, // 目标路由
    from: RouteLocationNormalizedLoaded, // 来源路由
    isPush: boolean, // 是否为 push 导航
    isFirstNavigation: boolean // 是否是应用首次导航（如页面初始化时的路由）
  ): // the return is not meant to be used
  Promise<unknown> {
    const { scrollBehavior } = options
    // 非浏览器环境（如SSR） 或 未配置 scrollBehavior → 直接返回成功 Promise
    if (!isBrowser || !scrollBehavior) return Promise.resolve()

    // 计算初始滚动位置（scrollPosition）
    const scrollPosition: _ScrollPositionNormalized | null =
      // 非 push 跳转（replace/后退）→ 读取保存的滚动位置
      (!isPush && getSavedScrollPosition(getScrollKey(to.fullPath, 0))) ||
      // 首次导航 或 非 push 跳转 → 读取 history.state 中的滚动位置
      ((isFirstNavigation || !isPush) &&
        (history.state as HistoryState) &&
        history.state.scroll) ||
      null // 其他情况 → 无滚动位置

    // 等待 DOM 更新完成后再执行滚动（路由跳转后组件渲染需要时间，避免滚动到未渲染的元素）
    return (
      nextTick()
        // 调用用户配置的 scrollBehavior，获取目标滚动位置
        .then(() => scrollBehavior(to, from, scrollPosition))
        // 若返回了滚动位置，执行实际的滚动操作
        .then(position => position && scrollToPosition(position))
        // 捕获滚动过程中的错误，触发全局错误处理
        .catch(err => triggerError(err, to, from))
    )
  }

  const go = (delta: number) => routerHistory.go(delta)

  let started: boolean | undefined
  const installedApps = new Set<App>()

  // NOTE: we need to cast router as Router because the experimental
  // data-loaders add many properties that aren't available here. We might want
  // to add them later on instead of having declare module in experimental
  const router = {
    currentRoute,
    listening: true, // 监听路由

    addRoute,
    removeRoute,
    clearRoutes: matcher.clearRoutes,
    hasRoute,
    getRoutes,
    resolve,
    options,

    push,
    replace,
    go,
    back: () => go(-1),
    forward: () => go(1),

    beforeEach: beforeGuards.add,
    beforeResolve: beforeResolveGuards.add,
    afterEach: afterGuards.add,

    onError: errorListeners.add,
    isReady,

    /**
     * Vue 应用集成（install 方法）
     * @param app
     */
    install(app: App) {
      // 注册全局组件 RouterLink 和 RouterView
      app.component('RouterLink', RouterLink)
      app.component('RouterView', RouterView)

      // 暴露 $router/$route 到全局
      app.config.globalProperties.$router = router as Router
      Object.defineProperty(app.config.globalProperties, '$route', {
        enumerable: true,
        get: () => unref(currentRoute),
      })

      // this initial navigation is only necessary on client, on server it doesn't
      // make sense because it will create an extra unnecessary navigation and could
      // lead to problems
      // 初始化首次导航（客户端）
      if (
        isBrowser &&
        // used for the initial navigation client side to avoid pushing
        // multiple times when the router is used in multiple apps
        !started &&
        currentRoute.value === START_LOCATION_NORMALIZED
      ) {
        // see above
        started = true
        push(routerHistory.location).catch(err => {
          if (__DEV__) warn('Unexpected error when starting the router:', err)
        })
      }

      const reactiveRoute = {} as RouteLocationNormalizedLoaded
      for (const key in START_LOCATION_NORMALIZED) {
        Object.defineProperty(reactiveRoute, key, {
          get: () => currentRoute.value[key as keyof RouteLocationNormalized],
          enumerable: true,
        })
      }

      // 提供路由注入（useRouter/useRoute）
      app.provide(routerKey, router as Router)
      app.provide(routeLocationKey, shallowReactive(reactiveRoute))
      app.provide(routerViewLocationKey, currentRoute)

      const unmountApp = app.unmount
      installedApps.add(app)

      // 应用卸载时清理
      app.unmount = function () {
        installedApps.delete(app)
        // the router is not attached to an app anymore
        if (installedApps.size < 1) {
          // invalidate the current navigation
          pendingLocation = START_LOCATION_NORMALIZED
          removeHistoryListener && removeHistoryListener()
          removeHistoryListener = null
          currentRoute.value = START_LOCATION_NORMALIZED
          started = false
          ready = false
        }
        unmountApp()
      }

      // TODO: this probably needs to be updated so it can be used by vue-termui
      if (
        (__DEV__ || __FEATURE_PROD_DEVTOOLS__) &&
        isBrowser &&
        !__STRIP_DEVTOOLS__
      ) {
        addDevtools(app, router as Router, matcher)
      }
    },
  } satisfies Pick<Router, Extract<keyof Router, string>>

  // TODO: type this as NavigationGuardReturn or similar instead of any
  function runGuardQueue(guards: Lazy<any>[]): Promise<any> {
    // Vue Router 的 beforeEach/beforeEnter/beforeResolve 等守卫会被收集为一个数组（guards），需要串行执行
    // 只有前一个守卫通过（Promise resolve），才能执行下一个
    return guards.reduce(
      (promise, guard) => promise.then(() => runWithContext(guard)),
      Promise.resolve()
    )
  }

  return router as Router
}

/*
  完整的导航解析流程
    导航被触发。
    在失活的组件里调用 beforeRouteLeave 守卫。
    调用全局的 beforeEach 守卫。
    在重用的组件里调用 beforeRouteUpdate 守卫(2.2+)。
    在路由配置里调用 beforeEnter。
    解析异步路由组件。
    在被激活的组件里调用 beforeRouteEnter。
    调用全局的 beforeResolve 守卫(2.5+)。
    导航被确认。
    调用全局的 afterEach 钩子。
    触发 DOM 更新。
    调用 beforeRouteEnter 守卫中传给 next 的回调函数，创建好的组件实例会作为回调函数的参数传入。
 */
