import {
  RouteRecordRaw,
  MatcherLocationRaw,
  MatcherLocation,
  isRouteName,
} from '../types'
import { createRouterError, ErrorTypes, MatcherError } from '../errors'
import { createRouteRecordMatcher, RouteRecordMatcher } from './pathMatcher'
import { RouteRecordNormalized } from './types'

import type {
  PathParams,
  PathParserOptions,
  _PathParserOptions,
} from './pathParserRanker'

import {
  comparePathParserScore,
  PATH_PARSER_OPTIONS_DEFAULTS,
} from './pathParserRanker'

import { warn } from '../warning'
import { assign, mergeOptions, noop } from '../utils'
import type { RouteRecordNameGeneric, _RouteRecordProps } from '../typed-routes'

/**
 * Internal RouterMatcher
 *
 * @internal
 */
export interface RouterMatcher {
  // 路由注册
  addRoute: (record: RouteRecordRaw, parent?: RouteRecordMatcher) => () => void
  // 移除路由
  removeRoute(matcher: RouteRecordMatcher): void
  removeRoute(name: NonNullable<RouteRecordNameGeneric>): void
  // 路由批量清理
  clearRoutes: () => void
  // 返回所有已注册的路由匹配器数组（按优先级排序）
  getRoutes: () => RouteRecordMatcher[]
  // 通过「路由名称」查找匹配器，返回 undefined 表示名称不存在
  getRecordMatcher: (
    name: NonNullable<RouteRecordNameGeneric>
  ) => RouteRecordMatcher | undefined

  /**
   * Resolves a location. Gives access to the route record that corresponds to the actual path as well as filling the corresponding params objects
   *
   * @param location - MatcherLocationRaw to resolve to a url
   * @param currentLocation - MatcherLocation of the current location
   */
  resolve: (
    location: MatcherLocationRaw,
    currentLocation: MatcherLocation
  ) => MatcherLocation
}

/**
 * Creates a Router Matcher.
 * 「初始化路由匹配系统」并返回符合 RouterMatcher 接口的完整匹配器实例
 * @internal
 * @param routes - array of initial routes 初始路由配置数组
 * @param globalOptions - global route options 原始配置
 */
export function createRouterMatcher(
  routes: Readonly<RouteRecordRaw[]>,
  globalOptions: PathParserOptions
): RouterMatcher {
  // normalized ordered array of matchers
  // 存储所有路由匹配器的数组（按优先级排序）
  const matchers: RouteRecordMatcher[] = []

  // 按路由名称索引的匹配器映射表
  const matcherMap = new Map<
    NonNullable<RouteRecordNameGeneric>,
    RouteRecordMatcher
  >()
  // 合并全局选项与默认选项，确保所有选项都有默认值
  globalOptions = mergeOptions<PathParserOptions>(
    // 合并全局选项与默认选项，确保所有选项都有默认值
    PATH_PARSER_OPTIONS_DEFAULTS,
    globalOptions
  )

  function getRecordMatcher(name: NonNullable<RouteRecordNameGeneric>) {
    return matcherMap.get(name)
  }

  /**
   * 动态添加路由
   * @param record  要添加的原始路由配置
   * @param parent  父路由匹配器（用于嵌套路由）
   * @param originalRecord  原始路由匹配器（用于别名关联）
   * @returns 路由匹配器的删除函数
   */
  function addRoute(
    record: RouteRecordRaw,
    parent?: RouteRecordMatcher,
    originalRecord?: RouteRecordMatcher
  ) {
    // used later on to remove by name
    const isRootAdd = !originalRecord // 标记是否为顶级路由添加（非别名）
    // 规范化路由记录（处理组件、路径等基础信息）
    const mainNormalizedRecord = normalizeRouteRecord(record)
    if (__DEV__) {
      checkChildMissingNameWithEmptyPath(mainNormalizedRecord, parent)
    }
    // we might be the child of an alias
    mainNormalizedRecord.aliasOf = originalRecord && originalRecord.record

    const options: PathParserOptions = mergeOptions(globalOptions, record)

    // generate an array of records to correctly handle aliases
    const normalizedRecords: RouteRecordNormalized[] = [mainNormalizedRecord]

    // 处理别名：为每个别名创建规范化记录
    if ('alias' in record) {
      const aliases =
        typeof record.alias === 'string' ? [record.alias] : record.alias!

      for (const alias of aliases) {
        normalizedRecords.push(
          // 为每个别名创建规范化记录，确保路径、参数等信息一致
          normalizeRouteRecord(
            assign({}, mainNormalizedRecord, {
              components: originalRecord
                ? originalRecord.record.components
                : mainNormalizedRecord.components,
              path: alias, // 别名路径
              // we might be the child of an alias
              // 若原始路由有 aliasOf 字段（别名关联），则当前别名路由也关联到该原始路由
              aliasOf: originalRecord
                ? originalRecord.record
                : mainNormalizedRecord,
            })
          )
        )
      }
    }

    let matcher: RouteRecordMatcher // 当前处理的路由匹配器
    let originalMatcher: RouteRecordMatcher | undefined // 原始路由的匹配器（非别名）

    // 处理所有规范化记录（原始路由 + 别名路由）
    for (const normalizedRecord of normalizedRecords) {
      const { path } = normalizedRecord
      // 嵌套路由拼接路径
      // 仅当「存在父路由（parent）」且「当前路径不是绝对路径（不以 / 开头）」时拼接
      if (parent && path[0] !== '/') {
        const parentPath = parent.record.path

        // 处理父路径末尾的斜杠：
        const connectingSlash =
          // 若父路径以 / 结尾（如 /user/），则不加斜杠；否则加 /（如父 /user + 子 profile → /user/profile）
          parentPath[parentPath.length - 1] === '/' ? '' : '/'

        normalizedRecord.path =
          parent.record.path + (path && connectingSlash + path)
      }

      // 禁止使用 * 通配符路由
      // 通配符路由（*）已被移除，需使用自定义正则表达式参数替代
      if (__DEV__ && normalizedRecord.path === '*') {
        throw new Error(
          'Catch all routes ("*") must now be defined using a param with a custom regexp.\n' +
            'See more at https://router.vuejs.org/guide/migration/#Removed-star-or-catch-all-routes.'
        )
      }

      // create the object beforehand, so it can be passed to children
      // 创建路由匹配器
      matcher = createRouteRecordMatcher(normalizedRecord, parent, options)

      if (__DEV__ && parent && path[0] === '/')
        checkMissingParamsInAbsolutePath(matcher, parent)

      // if we are an alias we must tell the original record that we exist,
      // so we can be removed
      // 别名关联：别名匹配器加入原始匹配器的 alias 数组，便于删除时递归清理
      if (originalRecord) {
        originalRecord.alias.push(matcher)
        if (__DEV__) {
          checkSameParams(originalRecord, matcher)
        }
      } else {
        // otherwise, the first record is the original and others are aliases
        originalMatcher = originalMatcher || matcher // 标记原始匹配器（非别名）
        if (originalMatcher !== matcher) originalMatcher.alias.push(matcher)

        // remove the route if named and only for the top record (avoid in nested calls)
        // this works because the original record is the first one
        if (isRootAdd && record.name && !isAliasRecord(matcher)) {
          if (__DEV__) {
            checkSameNameAsAncestor(record, parent)
          }
          removeRoute(record.name)
        }
      }

      // Avoid adding a record that doesn't display anything. This allows passing through records without a component to
      // not be reached and pass through the catch all route
      // 仅渲染型路由（有组件）才插入匹配器数组
      if (isMatchable(matcher)) {
        insertMatcher(matcher)
      }

      // 递归处理嵌套子路由
      if (mainNormalizedRecord.children) {
        const children = mainNormalizedRecord.children
        for (let i = 0; i < children.length; i++) {
          addRoute(
            children[i],
            matcher,
            originalRecord && originalRecord.children[i]
          )
        }
      }

      // if there was no original record, then the first one was not an alias and all
      // other aliases (if any) need to reference this record when adding children
      originalRecord = originalRecord || matcher // 标记原始匹配器（非别名）

      // TODO: add normalized records for more flexibility
      // if (parent && isAliasRecord(originalRecord)) {
      //   parent.children.push(originalRecord)
      // }
    }

    return originalMatcher
      ? () => {
          // since other matchers are aliases, they should be removed by the original matcher
          removeRoute(originalMatcher!)
        }
      : noop
  }

  /**
   * 支持通过「路由名称」或「路由匹配器对象」两种方式删除路由，同时递归清理子路由、别名路
   * @param matcherRef
   */
  function removeRoute(
    // RouteRecordNameGeneric：路由名称（字符串 / 符号，如 'user'）；
    // RouteRecordMatcher：路由匹配器对象（包含 score/re/record/children/alias 等字段）；
    matcherRef: NonNullable<RouteRecordNameGeneric> | RouteRecordMatcher
  ) {
    // 分支 1：入参是「路由名称」
    if (isRouteName(matcherRef)) {
      const matcher = matcherMap.get(matcherRef)
      if (matcher) {
        matcherMap.delete(matcherRef) // 移除名称→匹配器的映射
        matchers.splice(matchers.indexOf(matcher), 1) // 从匹配器数组删除
        matcher.children.forEach(removeRoute) // 递归删除子路由
        matcher.alias.forEach(removeRoute) // 递归删除别名路由
      }

      // 分支 2：入参是「路由匹配器对象」
    } else {
      const index = matchers.indexOf(matcherRef)
      if (index > -1) {
        matchers.splice(index, 1)
        if (matcherRef.record.name) matcherMap.delete(matcherRef.record.name)
        matcherRef.children.forEach(removeRoute)
        matcherRef.alias.forEach(removeRoute)
      }
    }
  }

  function getRoutes() {
    return matchers
  }

  /**
   * 将新的路由匹配器（RouteRecordMatcher）插入到匹配器数组（matchers）的正确优先级位置
   * @param matcher 新的路由匹配器
   */
  function insertMatcher(matcher: RouteRecordMatcher) {
    // 根据路由的 score（优先级分数）计算新匹配器在 matchers 数组中的插入位置
    const index = findInsertionIndex(matcher, matchers)
    matchers.splice(index, 0, matcher)
    // only add the original record to the name map
    // 排除别名记录，仅添加原始记录到名称映射
    // 原因？若别名路由也注册名称，会导致「一个名称对应多个匹配器」，引发命名冲突。
    if (matcher.record.name && !isAliasRecord(matcher))
      matcherMap.set(matcher.record.name, matcher)
  }

  /**
   * 将开发者传入的「原始导航目标」解析为标准化的 MatcherLocation 对象
   * @param location 原始导航目标，如 { name: 'user', params: { id: 1 } } 或 /user/1
   * @param currentLocation 当前路由位置，用于解析相对路径
   * @returns 标准化的 MatcherLocation 对象，包含 path、name、params 等字段
   */
  function resolve(
    location: Readonly<MatcherLocationRaw>,
    currentLocation: Readonly<MatcherLocation>
  ): MatcherLocation {
    let matcher: RouteRecordMatcher | undefined
    let params: PathParams = {}
    let path: MatcherLocation['path']
    let name: MatcherLocation['name']

    // 核心分支 1：按「路由名称」解析（
    if ('name' in location && location.name) {
      matcher = matcherMap.get(location.name)

      if (!matcher)
        throw createRouterError<MatcherError>(ErrorTypes.MATCHER_NOT_FOUND, {
          location,
        })

      // warn if the user is passing invalid params so they can debug it better when they get removed
      if (__DEV__) {
        const invalidParams: string[] = Object.keys(
          location.params || {}
        ).filter(paramName => !matcher!.keys.find(k => k.name === paramName))

        if (invalidParams.length) {
          warn(
            `Discarded invalid param(s) "${invalidParams.join(
              '", "'
            )}" when navigating. See https://github.com/vuejs/router/blob/main/packages/router/CHANGELOG.md#414-2022-08-22 for more details.`
          )
        }
      }

      name = matcher.record.name
      params = assign(
        // paramsFromLocation is a new object
        pickParams(
          currentLocation.params,
          // only keep params that exist in the resolved location
          // only keep optional params coming from a parent record
          matcher.keys
            .filter(k => !k.optional)
            .concat(
              matcher.parent ? matcher.parent.keys.filter(k => k.optional) : []
            )
            .map(k => k.name)
        ),
        // discard any existing params in the current location that do not exist here
        // #1497 this ensures better active/exact matching
        location.params &&
          pickParams(
            location.params,
            matcher.keys.map(k => k.name)
          )
      )
      // throws if cannot be stringified
      path = matcher.stringify(params)

      //  核心分支 2：按「路径」解析（
    } else if (location.path != null) {
      // no need to resolve the path with the matcher as it was provided
      // this also allows the user to control the encoding
      path = location.path

      if (__DEV__ && !path.startsWith('/')) {
        warn(
          `The Matcher cannot resolve relative paths but received "${path}". Unless you directly called \`matcher.resolve("${path}")\`, this is probably a bug in vue-router. Please open an issue at https://github.com/vuejs/router/issues/new/choose.`
        )
      }

      matcher = matchers.find(m => m.re.test(path))
      // matcher should have a value after the loop

      if (matcher) {
        // we know the matcher works because we tested the regexp
        params = matcher.parse(path)!
        name = matcher.record.name
      }
      // location is a relative path
    } else {
      // match by name or path of current route
      // 核心分支 3：兜底解析（无 name/path
      // 优先按当前路由名称找匹配器，否则按当前路径匹配
      matcher = currentLocation.name
        ? matcherMap.get(currentLocation.name)
        : matchers.find(m => m.re.test(currentLocation.path))
      if (!matcher)
        throw createRouterError<MatcherError>(ErrorTypes.MATCHER_NOT_FOUND, {
          location,
          currentLocation,
        })
      name = matcher.record.name
      // since we are navigating to the same location, we don't need to pick the
      // params like when `name` is provided
      params = assign({}, currentLocation.params, location.params)
      path = matcher.stringify(params)
    }

    // 收尾：构建 matched 路由记录数组
    const matched: MatcherLocation['matched'] = []
    let parentMatcher: RouteRecordMatcher | undefined = matcher
    while (parentMatcher) {
      // reversed order so parents are at the beginning

      matched.unshift(parentMatcher.record)
      parentMatcher = parentMatcher.parent
    }

    return {
      name,
      path,
      params,
      matched,
      meta: mergeMetaFields(matched),
    }
  }

  // add initial routes
  // 初始化传入的路由配置，调用addRoute注册每个路由
  routes.forEach(route => addRoute(route))

  function clearRoutes() {
    matchers.length = 0
    matcherMap.clear()
  }

  return {
    addRoute,
    resolve,
    removeRoute,
    clearRoutes,
    getRoutes,
    getRecordMatcher,
  }
}

/**
 * Picks an object param to contain only specified keys.
 *
 * @param params - params object to pick from
 * @param keys - keys to pick
 */
function pickParams(
  params: MatcherLocation['params'],
  keys: string[]
): MatcherLocation['params'] {
  const newParams = {} as MatcherLocation['params']

  for (const key of keys) {
    if (key in params) newParams[key] = params[key]
  }

  return newParams
}

/**
 * Normalizes a RouteRecordRaw. Creates a copy
 *
 * @param record
 * @returns the normalized version
 */
export function normalizeRouteRecord(
  record: RouteRecordRaw & { aliasOf?: RouteRecordNormalized }
): RouteRecordNormalized {
  const normalized: Omit<RouteRecordNormalized, 'mods'> = {
    path: record.path,
    redirect: record.redirect,
    name: record.name,
    meta: record.meta || {},
    aliasOf: record.aliasOf,
    beforeEnter: record.beforeEnter,
    props: normalizeRecordProps(record),
    children: record.children || [],
    instances: {}, // 组件实例缓存（key：视图名称，value：组件实例）
    leaveGuards: new Set(), // 路由离开守卫
    updateGuards: new Set(), // 路由更新守卫
    enterCallbacks: {}, // 路由进入回调
    // must be declared afterwards
    // mods: {},
    components:
      'components' in record
        ? record.components || null
        : // 若原始路由有 component 字段（单视图路由）：转换为 { default: 组件 } 的多视图格式；
          record.component && { default: record.component },
  }

  // mods contain modules and shouldn't be copied,
  // logged or anything. It's just used for internal
  // advanced use cases like data loaders
  // 定义私有内部字段 mods
  Object.defineProperty(normalized, 'mods', {
    value: {},
  })

  return normalized as RouteRecordNormalized
}

/**
 * Normalize the optional `props` in a record to always be an object similar to
 * components. Also accept a boolean for components.
 * @param record
 */
export function normalizeRecordProps(
  record: RouteRecordRaw
): Record<string, _RouteRecordProps> {
  const propsObject = {} as Record<string, _RouteRecordProps>
  // props does not exist on redirect records, but we can set false directly
  const props = record.props || false
  if ('component' in record) {
    propsObject.default = props
  } else {
    // NOTE: we could also allow a function to be applied to every component.
    // Would need user feedback for use cases
    for (const name in record.components)
      propsObject[name] = typeof props === 'object' ? props[name] : props
  }

  return propsObject
}

/**
 * Checks if a record or any of its parent is an alias
 * @param record
 */
function isAliasRecord(record: RouteRecordMatcher | undefined): boolean {
  while (record) {
    if (record.record.aliasOf) return true
    record = record.parent
  }

  return false
}

/**
 * Merge meta fields of an array of records
 *
 * @param matched - array of matched records
 */
function mergeMetaFields(matched: MatcherLocation['matched']) {
  return matched.reduce(
    (meta, record) => assign(meta, record.meta),
    {} as MatcherLocation['meta']
  )
}

type ParamKey = RouteRecordMatcher['keys'][number]

function isSameParam(a: ParamKey, b: ParamKey): boolean {
  return (
    a.name === b.name &&
    a.optional === b.optional &&
    a.repeatable === b.repeatable
  )
}

/**
 * Check if a path and its alias have the same required params
 *
 * @param a - original record
 * @param b - alias record
 */
function checkSameParams(a: RouteRecordMatcher, b: RouteRecordMatcher) {
  for (const key of a.keys) {
    if (!key.optional && !b.keys.find(isSameParam.bind(null, key)))
      return warn(
        `Alias "${b.record.path}" and the original record: "${a.record.path}" must have the exact same param named "${key.name}"`
      )
  }
  for (const key of b.keys) {
    if (!key.optional && !a.keys.find(isSameParam.bind(null, key)))
      return warn(
        `Alias "${b.record.path}" and the original record: "${a.record.path}" must have the exact same param named "${key.name}"`
      )
  }
}

/**
 * A route with a name and a child with an empty path without a name should warn when adding the route
 *
 * @param mainNormalizedRecord - RouteRecordNormalized
 * @param parent - RouteRecordMatcher
 */
export function checkChildMissingNameWithEmptyPath(
  mainNormalizedRecord: RouteRecordNormalized,
  parent?: RouteRecordMatcher
) {
  if (
    parent &&
    parent.record.name &&
    !mainNormalizedRecord.name &&
    !mainNormalizedRecord.path &&
    mainNormalizedRecord.children.length === 0
  ) {
    warn(
      `The route named "${String(
        parent.record.name
      )}" has a child without a name, an empty path, and no children. This is probably a mistake: using that name won't render the empty path child so you probably want to move the name to the child instead. If this is intentional, add a name to the child route to silence the warning.`
    )
  }
}

function checkSameNameAsAncestor(
  record: RouteRecordRaw,
  parent?: RouteRecordMatcher
) {
  for (let ancestor = parent; ancestor; ancestor = ancestor.parent) {
    if (ancestor.record.name === record.name) {
      throw new Error(
        `A route named "${String(record.name)}" has been added as a ${
          parent === ancestor ? 'child' : 'descendant'
        } of a route with the same name. Route names must be unique and a nested route cannot use the same name as an ancestor.`
      )
    }
  }
}

function checkMissingParamsInAbsolutePath(
  record: RouteRecordMatcher,
  parent: RouteRecordMatcher
) {
  for (const key of parent.keys) {
    if (!record.keys.find(isSameParam.bind(null, key)))
      return warn(
        `Absolute path "${record.record.path}" must have the exact same param named "${key.name}" as its parent "${parent.record.path}".`
      )
  }
}

/**
 * Performs a binary search to find the correct insertion index for a new matcher.
 *
 * Matchers are primarily sorted by their score. If scores are tied then we also consider parent/child relationships,
 * with descendants coming before ancestors. If there's still a tie, new routes are inserted after existing routes.
 *
 * @param matcher - new matcher to be inserted
 * @param matchers - existing matchers
 */
function findInsertionIndex(
  matcher: RouteRecordMatcher,
  matchers: RouteRecordMatcher[]
) {
  // First phase: binary search based on score
  let lower = 0
  let upper = matchers.length

  while (lower !== upper) {
    const mid = (lower + upper) >> 1
    const sortOrder = comparePathParserScore(matcher, matchers[mid])

    if (sortOrder < 0) {
      upper = mid
    } else {
      lower = mid + 1
    }
  }

  // Second phase: check for an ancestor with the same score
  const insertionAncestor = getInsertionAncestor(matcher)

  if (insertionAncestor) {
    upper = matchers.lastIndexOf(insertionAncestor, upper - 1)

    if (__DEV__ && upper < 0) {
      // This should never happen
      warn(
        `Finding ancestor route "${insertionAncestor.record.path}" failed for "${matcher.record.path}"`
      )
    }
  }

  return upper
}

function getInsertionAncestor(matcher: RouteRecordMatcher) {
  let ancestor: RouteRecordMatcher | undefined = matcher

  while ((ancestor = ancestor.parent)) {
    if (
      isMatchable(ancestor) &&
      comparePathParserScore(matcher, ancestor) === 0
    ) {
      return ancestor
    }
  }

  return
}

/**
 * Checks if a matcher can be reachable. This means if it's possible to reach it as a route. For example, routes without
 * a component, or name, or redirect, are just used to group other routes.
 * @param matcher
 * @param matcher.record record of the matcher
 * @returns
 */
function isMatchable({ record }: RouteRecordMatcher): boolean {
  return !!(
    record.name ||
    (record.components && Object.keys(record.components).length) ||
    record.redirect
  )
}

export type { PathParserOptions, _PathParserOptions }
