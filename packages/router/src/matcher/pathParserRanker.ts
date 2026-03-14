import { Token, TokenType } from './pathTokenizer'
import { assign, isArray } from '../utils'

export type PathParams = Record<string, string | string[]>

/**
 * A param in a url like `/users/:id`
 */
interface PathParserParamKey {
  name: string
  repeatable: boolean
  optional: boolean
}

export interface PathParser {
  /**
   * The regexp used to match a url
   */
  re: RegExp

  /**
   * The score of the parser
   */
  score: Array<number[]>

  /**
   * Keys that appeared in the path
   */
  keys: PathParserParamKey[]
  /**
   * Parses a url and returns the matched params or null if it doesn't match. An
   * optional param that isn't preset will be an empty string. A repeatable
   * param will be an array if there is at least one value.
   *
   * @param path - url to parse
   * @returns a Params object, empty if there are no params. `null` if there is
   * no match
   */
  parse(path: string): PathParams | null

  /**
   * Creates a string version of the url
   *
   * @param params - object of params
   * @returns a url
   */
  stringify(params: PathParams): string
}

/**
 * @internal
 */
export interface _PathParserOptions {
  /**
   * Makes the RegExp case-sensitive.
   * 控制路由路径匹配时是否区分大小写（影响生成的正则表达式是否添加 i 标志）
   * @defaultValue `false` false（不区分大小写，如 /Home 和 /home 视为同一路由）
   */
  sensitive?: boolean

  /**
   * Whether to disallow a trailing slash or not.
   * 控制是否严格匹配路径末尾的斜杠（/）
   * @defaultValue `false` false（允许末尾斜杠，如 /home 和 /home/ 视为同一路由）
   */
  strict?: boolean

  /**
   * Should the RegExp match from the beginning by prepending a `^` to it.
   * @internal
   * 控制生成的路径匹配正则是否添加 ^ 前缀（即是否从字符串开头开始匹配）
   * @defaultValue `true` true（必须从路径开头匹配，符合路由匹配的基本逻辑）
   */
  start?: boolean

  /**
   * Should the RegExp match until the end by appending a `$` to it.
   * 控制生成的路径匹配正则是否添加 $ 后缀（即是否完整匹配路径末尾）
   * @deprecated this option will alsways be `true` in the future. Open a discussion in vuejs/router if you need this to be `false`
   * 已废弃
   * @defaultValue `true`
   */
  end?: boolean
}

export type PathParserOptions = Pick<
  _PathParserOptions,
  'end' | 'sensitive' | 'strict'
>

// default pattern for a param: non-greedy everything but /
const BASE_PARAM_PATTERN = '[^/]+?'

const BASE_PATH_PARSER_OPTIONS: Required<_PathParserOptions> = {
  sensitive: false,
  strict: false,
  start: true,
  end: true,
}

// Scoring values used in tokensToParser
const enum PathScore {
  _multiplier = 10,
  Root = 9 * _multiplier, // just /
  Segment = 4 * _multiplier, // /a-segment
  SubSegment = 3 * _multiplier, // /multiple-:things-in-one-:segment
  Static = 4 * _multiplier, // /static
  Dynamic = 2 * _multiplier, // /:someId
  BonusCustomRegExp = 1 * _multiplier, // /:someId(\\d+)
  BonusWildcard = -4 * _multiplier - BonusCustomRegExp, // /:namedWildcard(.*) we remove the bonus added by the custom regexp
  BonusRepeatable = -2 * _multiplier, // /:w+ or /:w*
  BonusOptional = -0.8 * _multiplier, // /:w? or /:w*
  // these two have to be under 0.1 so a strict /:page is still lower than /:a-:b
  BonusStrict = 0.07 * _multiplier, // when options strict: true is passed, as the regex omits \/?
  BonusCaseSensitive = 0.025 * _multiplier, // when options strict: true is passed, as the regex omits \/?
}

// Special Regex characters that must be escaped in static tokens
const REGEX_CHARS_RE = /[.+*?^${}()[\]/\\]/g

/**
 * Creates a path parser from an array of Segments (a segment is an array of Tokens)
 * 将「路径令牌二维数组（Token[][]）」转换为「路径解析器（PathParser）」
 *
 * @param segments - array of segments returned by tokenizePath
 * @param extraOptions - optional options for the regexp
 * @returns a PathParser
 */
export function tokensToParser(
  segments: Array<Token[]>,
  extraOptions?: _PathParserOptions
): PathParser {
  // 合并默认选项和用户传入选项
  const options = assign({}, BASE_PATH_PARSER_OPTIONS, extraOptions)

  // the amount of scores is the same as the length of segments except for the root segment "/"
  // 存储每个路径段 / 令牌的匹配分数，用于多路由匹配时的优先级排序（如静态路由 /user 优先级高于动态路由 /:id）
  const score: Array<number[]> = []
  // the regexp as a string
  let pattern = options.start ? '^' : ''
  // extracted keys
  const keys: PathParserParamKey[] = []

  // 遍历路径段生成正则与分数
  for (const segment of segments) {
    // the root segment needs special treatment
    // 根路径段（空数组）特殊处理：分数初始化为 [PathScore.Root]
    const segmentScores: number[] = segment.length ? [] : [PathScore.Root]

    // allow trailing slash
    // 严格模式下，空段（末尾斜杠）添加 / 到正则
    if (options.strict && !segment.length) pattern += '/'

    // 遍历当前段的所有令牌
    for (let tokenIndex = 0; tokenIndex < segment.length; tokenIndex++) {
      const token = segment[tokenIndex]

      // resets the score if we are inside a sub-segment /:a-other-:b
      // 初始化子段分数：基础分 + 区分大小写加分
      let subSegmentScore: number =
        PathScore.Segment +
        // 配置 区分大小写 时，添加额外分数，提升优先级 0.25
        (options.sensitive ? PathScore.BonusCaseSensitive : 0)

      // 1、静态令牌（如 /user）：基础分 + 静态令牌分
      if (token.type === TokenType.Static) {
        // prepend the slash if we are starting a new segment
        if (!tokenIndex) pattern += '/' // 新段开头添加 /（避免拼接出 // 等无效路径）

        // 转义正则特殊字符后拼接到正则字符串
        pattern += token.value.replace(REGEX_CHARS_RE, '\\$&')
        subSegmentScore += PathScore.Static // 静态令牌加分，提升优先级 40

        // 2、动态参数
      } else if (token.type === TokenType.Param) {
        const { value, repeatable, optional, regexp } = token
        keys.push({
          name: value,
          repeatable,
          optional,
        })
        const re = regexp ? regexp : BASE_PARAM_PATTERN

        // the user provided a custom regexp /:id(\\d+)
        // 自定义正则表达式
        if (re !== BASE_PARAM_PATTERN) {
          subSegmentScore += PathScore.BonusCustomRegExp // 提升优先级 10
          // make sure the regexp is valid before using it
          try {
            // 校验正则合法性，非法则抛错
            new RegExp(`(${re})`)
          } catch (err) {
            throw new Error(
              `Invalid custom RegExp for param "${value}" (${re}): ` +
                (err as Error).message
            )
          }
        }

        // when we repeat we must take care of the repeating leading slash
        // 可重复参数（如 /:w+）：添加 (?:/(?:${re}))* 匹配多个子路径段
        let subPattern = repeatable ? `((?:${re})(?:/(?:${re}))*)` : `(${re})`

        // prepend the slash if we are starting a new segment
        // 开头处理
        if (!tokenIndex)
          subPattern =
            // avoid an optional / if there are more segments e.g. /:p?-static
            // or /:p?-:p2
            optional && segment.length < 2
              ? // 可选参数且段内只有一个令牌 → 包裹非捕获组（避免多余 /）
                `(?:/${subPattern})` // 如 /:id? → (?:/(\d+))?
              : '/' + subPattern

        if (optional) subPattern += '?'

        pattern += subPattern

        subSegmentScore += PathScore.Dynamic // 动态参数加分，提升优先级 20

        if (optional) subSegmentScore += PathScore.BonusOptional // 可选参数加分，降低优先级 -8
        if (repeatable) subSegmentScore += PathScore.BonusRepeatable // 可重复参数加分，降低优先级 -20
        if (re === '.*') subSegmentScore += PathScore.BonusWildcard // 通配符参数加分，降低优先级 -50
      }

      segmentScores.push(subSegmentScore) // 将当前令牌分数加入段分数数组
    }

    // an empty array like /home/ -> [[{home}], []]
    // if (!segment.length) pattern += '/'

    score.push(segmentScores) // 将当前段分数加入总分数数组
  }

  // only apply the strict bonus to the last score
  // 严格模式下，给最后一个分数添加严格模式加分
  if (options.strict && options.end) {
    const i = score.length - 1
    score[i][score[i].length - 1] += PathScore.BonusStrict
  }

  // TODO: dev only warn double trailing slash
  // 非严格模式下，允许末尾斜杠（添加 /?）
  if (!options.strict) pattern += '/?'

  // 结束符处理：end=true → 添加 $
  if (options.end) pattern += '$'
  // allow paths like /dynamic to only match dynamic or dynamic/... but not dynamic_something_else
  // 否则处理为 (?:/|$)（匹配末尾或斜杠）
  else if (options.strict && !pattern.endsWith('/')) pattern += '(?:/|$)'

  const re = new RegExp(pattern, options.sensitive ? '' : 'i')

  // 实现 parse 方法（URL → 参数）
  function parse(path: string): PathParams | null {
    const match = path.match(re)
    const params: PathParams = {}

    if (!match) return null

    // 遍历匹配结果（跳过第 0 项，第 0 项是完整匹配）
    for (let i = 1; i < match.length; i++) {
      const value: string = match[i] || ''
      const key = keys[i - 1]
      // 可重复参数 → 拆分为数组；否则直接赋值
      params[key.name] = value && key.repeatable ? value.split('/') : value
    }

    return params
  }

  // 实现 stringify 方法（参数 → URL）
  function stringify(params: PathParams): string {
    let path = ''
    // for optional parameters to allow to be empty
    let avoidDuplicatedSlash: boolean = false // 避免重复斜杠的标记

    for (const segment of segments) {
      if (!avoidDuplicatedSlash || !path.endsWith('/')) path += '/'
      avoidDuplicatedSlash = false

      for (const token of segment) {
        if (token.type === TokenType.Static) {
          path += token.value
        } else if (token.type === TokenType.Param) {
          const { value, repeatable, optional } = token

          // 获取参数值
          const param: string | readonly string[] =
            value in params ? params[value] : ''

          // 校验：非可重复参数不能传数组
          if (isArray(param) && !repeatable) {
            throw new Error(
              `Provided param "${value}" is an array but it is not repeatable (* or + modifiers)`
            )
          }

          // 数组参数 → 拼接为 / 分隔的字符串
          const text: string = isArray(param)
            ? (param as string[]).join('/')
            : (param as string)

          // 参数值为空处理
          if (!text) {
            // 可选参数处理
            if (optional) {
              // if we have more than one optional param like /:a?-static we don't need to care about the optional param
              if (segment.length < 2) {
                // remove the last slash as we could be at the end
                if (path.endsWith('/'))
                  path = path.slice(0, -1) // 移除末尾斜杠
                // do not append a slash on the next iteration
                else avoidDuplicatedSlash = true
              }
            } else throw new Error(`Missing required param "${value}"`)
          }
          path += text // 参数值非空 → 拼接
        }
      }
    }

    // avoid empty path when we have multiple optional params
    // 空路径 → 返回 /；否则返回拼接结果
    return path || '/'
  }

  return {
    re,
    score,
    keys,
    parse,
    stringify,
  }
}

/**
 * Compares an array of numbers as used in PathParser.score and returns a
 * number. This function can be used to `sort` an array
 *
 * @param a - first array of numbers
 * @param b - second array of numbers
 * @returns 0 if both are equal, < 0 if a should be sorted first, > 0 if b
 * should be sorted first
 */
function compareScoreArray(a: number[], b: number[]): number {
  let i = 0
  while (i < a.length && i < b.length) {
    const diff = b[i] - a[i]
    // only keep going if diff === 0
    if (diff) return diff

    i++
  }

  // if the last subsegment was Static, the shorter segments should be sorted first
  // otherwise sort the longest segment first
  if (a.length < b.length) {
    return a.length === 1 && a[0] === PathScore.Static + PathScore.Segment
      ? -1
      : 1
  } else if (a.length > b.length) {
    return b.length === 1 && b[0] === PathScore.Static + PathScore.Segment
      ? 1
      : -1
  }

  return 0
}

/**
 * Compare function that can be used with `sort` to sort an array of PathParser
 *
 * @param a - first PathParser
 * @param b - second PathParser
 * @returns 0 if both are equal, < 0 if a should be sorted first, > 0 if b
 */
export function comparePathParserScore(
  a: Pick<PathParser, 'score'>,
  b: Pick<PathParser, 'score'>
): number {
  let i = 0
  const aScore = a.score
  const bScore = b.score
  while (i < aScore.length && i < bScore.length) {
    const comp = compareScoreArray(aScore[i], bScore[i])
    // do not return if both are equal
    if (comp) return comp

    i++
  }
  if (Math.abs(bScore.length - aScore.length) === 1) {
    if (isLastScoreNegative(aScore)) return 1
    if (isLastScoreNegative(bScore)) return -1
  }

  // if a and b share the same score entries but b has more, sort b first
  return bScore.length - aScore.length
  // this is the ternary version
  // return aScore.length < bScore.length
  //   ? 1
  //   : aScore.length > bScore.length
  //   ? -1
  //   : 0
}

/**
 * This allows detecting splats at the end of a path: /home/:id(.*)*
 *
 * @param score - score to check
 * @returns true if the last entry is negative
 */
function isLastScoreNegative(score: PathParser['score']): boolean {
  const last = score[score.length - 1]
  return score.length > 0 && last[last.length - 1] < 0
}
export const PATH_PARSER_OPTIONS_DEFAULTS: PathParserOptions = {
  strict: false,
  end: true,
  sensitive: false,
}
