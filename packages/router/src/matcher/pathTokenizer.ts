export const enum TokenType {
  Static,
  Param,
  Group,
}

const enum TokenizerState {
  Static,
  Param,
  ParamRegExp, // custom re for a param
  ParamRegExpEnd, // check if there is any ? + *
  EscapeNext,
}

// 静态文本令牌
interface TokenStatic {
  type: TokenType.Static // 令牌类型标识，0
  value: string // 静态文本内容（如 '/user/'、'profile'）
}

// 动态参数令牌
interface TokenParam {
  type: TokenType.Param // 令牌类型标识，1
  regexp?: string // 参数匹配的正则表达式（默认 '[^/]+'，可自定义）
  value: string // 参数名称（即路径中 : 后的字符串）
  // 标记参数是否为「可选」
  // 由路径中的 ? 或 * 修饰符决定：
  // /user/:id? → optional: true（参数可选，可匹配 /user 或 /user/123）；
  // /user/:id* → optional: true（* 表示 0+ 次重复，天然可选）；
  // /user/:id → optional: false（必填，仅匹配 /user/123，不匹配 /user）；
  optional: boolean
  // 标记参数是否为「可重复」
  // 由路径中的 * 或 + 修饰符决定：
  // /user/:ids* → repeatable: true（0+ 次重复，可匹配 /user//user/1//user/1/2）；
  // /user/:ids+ → repeatable: true（1+ 次重复，可匹配 /user/1//user/1/2，不匹配 /user）；
  // /user/:id → repeatable: false（不可重复，仅匹配单个参数值）；
  repeatable: boolean
}
// 分组规则令牌（可选，高级场景）
interface TokenGroup {
  type: TokenType.Group // 令牌类型标识，2
  // 分组内只能包含 TokenStatic（静态文本）、TokenParam（动态参数），但不能嵌套
  value: Exclude<Token, TokenGroup>[]
}

export type Token = TokenStatic | TokenParam | TokenGroup

const ROOT_TOKEN: Token = {
  type: TokenType.Static,
  value: '',
}

const VALID_PARAM_RE = /[a-zA-Z0-9_]/
// After some profiling, the cache seems to be unnecessary because tokenizePath
// (the slowest part of adding a route) is very fast

// const tokenCache = new Map<string, Token[][]>()

/**
 * 拆分静态路径段和动态参数段
 * @param path 路由路径字符串（如 /user/:id/profile）
 * @returns 路径令牌数组（如 [['/user/', { name: 'id', regex: '[^/]+' }, '/profile']]）
 */
export function tokenizePath(path: string): Array<Token[]> {
  if (!path) return [[]] // 空路径 → 返回 [[]]

  // 根路径 → 返回 [[ROOT_TOKEN]]
  if (path === '/') return [[ROOT_TOKEN]]

  // 非根路径但不以 / 开头 → 抛错（路由路径必须以 / 开头）
  if (!path.startsWith('/')) {
    throw new Error(
      __DEV__
        ? `Route paths should start with a "/": "${path}" should be "/${path}".`
        : `Invalid path "${path}"`
    )
  }

  // if (tokenCache.has(path)) return tokenCache.get(path)!

  function crash(message: string) {
    throw new Error(`ERR (${state})/"${buffer}": ${message}`)
  }

  let state: TokenizerState = TokenizerState.Static // 初始状态：静态文本
  let previousState: TokenizerState = state // 前一个状态：初始状态为静态文本

  // 最终输出的二维令牌数组
  const tokens: Array<Token[]> = []
  // the segment will always be valid because we get into the initial state
  // with the leading /

  let segment!: Token[] // 当前路径段的令牌数组

  // 完成当前路径段的处理（推入tokens，重置segment）
  function finalizeSegment() {
    if (segment) tokens.push(segment)
    segment = []
  }

  // index on the path
  let i = 0
  // char at index
  let char: string = '' // 当前遍历到的字符
  // buffer of the value read
  let buffer: string = '' // 当前路径段的字符缓冲区
  // custom regexp for a param
  let customRe: string = '' // 参数自定义正则缓冲区

  // 令牌生成函数
  function consumeBuffer() {
    if (!buffer) return

    // 静态文本状态处理
    if (state === TokenizerState.Static) {
      segment.push({
        type: TokenType.Static,
        value: buffer,
      })

      // 参数相关状态处理：Param/ParamRegExp/ParamRegExpEnd
    } else if (
      state === TokenizerState.Param ||
      state === TokenizerState.ParamRegExp ||
      state === TokenizerState.ParamRegExpEnd
    ) {
      // 带 */+ 修饰符的可重复参数，必须独占一个路径段（不能和其他令牌共存）
      // 错误示例：路径 /user:ids+
      if (segment.length > 1 && (char === '*' || char === '+'))
        crash(
          `A repeatable param (${buffer}) must be alone in its segment. eg: '/:ids+.`
        )
      segment.push({
        type: TokenType.Param,
        value: buffer,
        regexp: customRe,
        repeatable: char === '*' || char === '+',
        optional: char === '*' || char === '?',
      })
      // 异常状态处理
    } else {
      crash('Invalid state to consume buffer')
    }

    buffer = '' // 缓冲区重置
  }

  function addCharToBuffer() {
    buffer += char
  }

  // 状态机核心循环（遍历路径字符）
  while (i < path.length) {
    char = path[i++]

    // 转义字符处理（\）：非参数正则状态下，\ 后接的字符直接作为普通字符
    // 示例 1：路径 /user\:id → 用户希望 :id 是静态文本，而非动态参数，需用 \ 转义 :；
    if (char === '\\' && state !== TokenizerState.ParamRegExp) {
      previousState = state // 保存当前状态
      state = TokenizerState.EscapeNext // 切换到「转义下一个字符」状态
      continue
    }

    // 状态机分支处理
    switch (state) {
      case TokenizerState.Static:
        // 检测到路径分隔符 /，表示当前路径段结束，需要收尾当前段的解析
        if (char === '/') {
          // 检查缓冲区是否有内容
          if (buffer) {
            consumeBuffer()
          }
          finalizeSegment()

          // 动态参数解析
        } else if (char === ':') {
          consumeBuffer()
          state = TokenizerState.Param
        } else {
          addCharToBuffer() // 普通字符 → 加入缓冲区
        }
        break

      // 状态2：转义下一个字符
      case TokenizerState.EscapeNext:
        addCharToBuffer()
        state = previousState
        break

      // 状态3：参数名（如 :id 中的 id）
      case TokenizerState.Param:
        // 检测到参数正则开始符 (，表示自定义正则开始
        if (char === '(') {
          state = TokenizerState.ParamRegExp
        } else if (VALID_PARAM_RE.test(char)) {
          addCharToBuffer() // 收集参数名字符
        } else {
          consumeBuffer()
          state = TokenizerState.Static // 恢复静态文本状态
          // go back one character if we were not modifying
          // 非修饰符字符，索引回退一位（让静态状态重新处理该字符）
          if (char !== '*' && char !== '?' && char !== '+') i--
        }
        break

      // 状态4：参数自定义正则（如 :id(\\d+) 中的 \\d+）
      case TokenizerState.ParamRegExp:
        // TODO: is it worth handling nested regexp? like :p(?:prefix_([^/]+)_suffix)
        // it already works by escaping the closing )
        // https://paths.esm.dev/?p=AAMeJbiAwQEcDKbAoAAkP60PG2R6QAvgNaA6AFACM2ABuQBB#
        // is this really something people need since you can also write
        // /prefix_:p()_suffix
        // 处理正则结束符
        if (char === ')') {
          // handle the escaped )
          // 检查最后一个正则字符是否是转义符 \
          if (customRe[customRe.length - 1] == '\\')
            customRe = customRe.slice(0, -1) + char // 移除转义符 \，将 ) 作为普通字符加入正则

          // 无转义 → 正则结束，切换到 ParamRegExpEnd 状态
          else state = TokenizerState.ParamRegExpEnd
        } else {
          customRe += char // 将字符追加到 customRe 缓冲区
        }
        break

      // 状态5：参数正则结束
      case TokenizerState.ParamRegExpEnd:
        // same as finalizing a param
        consumeBuffer() // 生成参数令牌
        state = TokenizerState.Static
        // go back one character if we were not modifying
        // 索引回退逻辑 → 处理修饰符 / 非法字符
        // 非修饰符（如 //(/a 等）：回退索引 → 让静态状态重新处理该字符（避免字符丢失）
        if (char !== '*' && char !== '?' && char !== '+') i--
        customRe = ''
        break

      default:
        crash('Unknown state')
        break
    }
  }

  // 校验：参数正则未闭合（如 :id(\\d+ 缺少 )）
  if (state === TokenizerState.ParamRegExp)
    crash(`Unfinished custom RegExp for param "${buffer}"`)

  consumeBuffer()
  finalizeSegment()

  // tokenCache.set(path, tokens)

  return tokens
}
