import { RouteRecord } from './types'
import {
  tokensToParser,
  PathParser,
  PathParserOptions,
} from './pathParserRanker'
import { tokenizePath } from './pathTokenizer'
import { warn } from '../warning'
import { assign } from '../utils'

export interface RouteRecordMatcher extends PathParser {
  record: RouteRecord
  parent: RouteRecordMatcher | undefined
  children: RouteRecordMatcher[]
  // aliases that must be removed when removing this record
  alias: RouteRecordMatcher[]
}

/**
 * 将「标准化路由记录（RouteRecord）」转换为「路由匹配器（RouteRecordMatcher）」
 * @param record 标准化路由记录
 * @param parent 父路由匹配器
 * @param options 路径解析选项
 * @returns 路由记录匹配器
 */
export function createRouteRecordMatcher(
  record: Readonly<RouteRecord>,
  parent: RouteRecordMatcher | undefined,
  options?: PathParserOptions
): RouteRecordMatcher {
  // tokenizePath 拆分静态路径段和动态参数段
  /**
   * 步骤 2：令牌转解析器（tokensToParser）
      将路径令牌数组转换为 PathParser（路径解析器），包含核心能力：
      parse 方法：将 URL 路径解析为参数（如 /user/123/profile → { id: '123' }）；
      stringify 方法：将参数还原为 URL 路径（如 { id: '123' } → /user/123/profile）；
      regex 属性：匹配路径的正则表达式；
      keys 属性：路径参数的元信息（名称、正则、是否可选等）。
   */
  const parser = tokensToParser(tokenizePath(record.path), options)

  // warn against params with the same name
  // 开发环境校验重复参数名
  if (__DEV__) {
    const existingKeys = new Set<string>()
    for (const key of parser.keys) {
      if (existingKeys.has(key.name))
        warn(
          `Found duplicated params with name "${key.name}" for path "${record.path}". Only the last one will be available on "$route.params".`
        )
      existingKeys.add(key.name)
    }
  }

  // 构建路由匹配器对象
  const matcher: RouteRecordMatcher = assign(parser, {
    record,
    parent,
    // these needs to be populated by the parent
    children: [],
    alias: [],
  })

  // 关联父匹配器的子列表（嵌套场景）
  if (parent) {
    // both are aliases or both are not aliases
    // we don't want to mix them because the order is used when
    // passing originalRecord in Matcher.addRoute
    if (!matcher.record.aliasOf === !parent.record.aliasOf)
      parent.children.push(matcher)
  }

  return matcher
}
