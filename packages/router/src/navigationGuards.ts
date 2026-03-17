import { isRouteLocation, Lazy, RouteComponent } from './types'

import type {
  RouteLocationNormalized,
  RouteLocationNormalizedLoaded,
  NavigationGuard,
  RouteLocation,
  RouteLocationRaw,
  NavigationGuardNext,
  NavigationGuardNextCallback,
} from './typed-routes'

import {
  createRouterError,
  ErrorTypes,
  NavigationFailure,
  NavigationRedirectError,
} from './errors'
import {
  ComponentOptions,
  onUnmounted,
  onActivated,
  onDeactivated,
  ComputedRef,
} from 'vue'
import { inject, getCurrentInstance } from 'vue'
import { matchedRouteKey } from './injectionSymbols'
import { RouteRecordNormalized } from './matcher/types'
import { isESModule, isRouteComponent } from './utils'
import { warn } from './warning'
import { isSameRouteRecord } from './location'

function registerGuard(
  activeRecordRef: ComputedRef<RouteRecordNormalized | undefined>,
  name: 'leaveGuards' | 'updateGuards',
  guard: NavigationGuard
) {
  const record = activeRecordRef.value
  if (!record) {
    if (__DEV__) {
      const fnName =
        name === 'updateGuards' ? 'onBeforeRouteUpdate' : 'onBeforeRouteLeave'
      warn(
        `No active route record was found when calling \`${fnName}()\`. ` +
          `Make sure you call this function inside a component child of <router-view>. ` +
          `Maybe you called it inside of App.vue?`
      )
    }
    return
  }

  // Track the current record the guard is registered with
  let currentRecord = record

  const removeFromList = () => {
    currentRecord[name].delete(guard)
  }

  onUnmounted(removeFromList)
  onDeactivated(removeFromList)

  onActivated(() => {
    // When reactivated, check if the active record has changed (e.g., keep-alive
    // component reactivated for a different route). If so, register with the new record.
    const newRecord = activeRecordRef.value
    if (__DEV__ && !newRecord) {
      warn(
        'No active route record was found when reactivating component with navigation guard. ' +
          'This is likely a bug in vue-router. Please report it.'
      )
    }
    if (newRecord) {
      currentRecord = newRecord
    }
    currentRecord[name].add(guard)
  })

  currentRecord[name].add(guard)
}

/**
 * Add a navigation guard that triggers whenever the component for the current
 * location is about to be left. Similar to {@link beforeRouteLeave} but can be
 * used in any component. The guard is removed when the component is unmounted.
 *
 * @param leaveGuard - {@link NavigationGuard}
 */
export function onBeforeRouteLeave(leaveGuard: NavigationGuard) {
  if (__DEV__ && !getCurrentInstance()) {
    warn(
      'getCurrentInstance() returned null. onBeforeRouteLeave() must be called at the top of a setup function'
    )
    return
  }

  const activeRecordRef = inject(
    matchedRouteKey,
    // to avoid warning
    {} as any
  ) as ComputedRef<RouteRecordNormalized | undefined>

  registerGuard(activeRecordRef, 'leaveGuards', leaveGuard)
}

/**
 * Add a navigation guard that triggers whenever the current location is about
 * to be updated. Similar to {@link beforeRouteUpdate} but can be used in any
 * component. The guard is removed when the component is unmounted.
 *
 * @param updateGuard - {@link NavigationGuard}
 */
export function onBeforeRouteUpdate(updateGuard: NavigationGuard) {
  if (__DEV__ && !getCurrentInstance()) {
    warn(
      'getCurrentInstance() returned null. onBeforeRouteUpdate() must be called at the top of a setup function'
    )
    return
  }

  const activeRecordRef = inject(
    matchedRouteKey,
    // to avoid warning
    {} as any
  ) as ComputedRef<RouteRecordNormalized | undefined>

  registerGuard(activeRecordRef, 'updateGuards', updateGuard)
}

export function guardToPromiseFn(
  guard: NavigationGuard,
  to: RouteLocationNormalized,
  from: RouteLocationNormalizedLoaded
): () => Promise<void>
export function guardToPromiseFn(
  guard: NavigationGuard,
  to: RouteLocationNormalized,
  from: RouteLocationNormalizedLoaded,
  record: RouteRecordNormalized,
  name: string,
  runWithContext: <T>(fn: () => T) => T
): () => Promise<void>

/**
 * 任意导航守卫（同步 / 异步、新旧写法）封装为标准化 Promise 函数
 * @param guard
 * @param to
 * @param from
 * @param record
 * @param name
 * @param runWithContext
 * @returns
 */
export function guardToPromiseFn(
  guard: NavigationGuard,
  to: RouteLocationNormalized,
  from: RouteLocationNormalizedLoaded,
  record?: RouteRecordNormalized,
  name?: string,
  runWithContext: <T>(fn: () => T) => T = fn => fn()
): () => Promise<void> {
  // keep a reference to the enterCallbackArray to prevent pushing callbacks if a new navigation took place
  // 缓存 enterCallbacks 数组（用于 beforeRouteEnter 的实例回调）
  const enterCallbackArray =
    record &&
    // name is defined if record is because of the function overload
    (record.enterCallbacks[name!] = record.enterCallbacks[name!] || [])

  // 返回封装后的 Promise 函数
  return () =>
    new Promise((resolve, reject) => {
      const next: NavigationGuardNext = (
        valid?: boolean | RouteLocationRaw | NavigationGuardNextCallback | Error
      ) => {
        // 终止导航：reject 导航中止错误
        if (valid === false) {
          reject(
            createRouterError<NavigationFailure>(
              ErrorTypes.NAVIGATION_ABORTED,
              {
                from,
                to,
              }
            )
          )
          // 抛出错误：直接 reject 错误对象
        } else if (valid instanceof Error) {
          reject(valid)

          // 重定向：reject 重定向错误（上层会触发新导航）
        } else if (isRouteLocation(valid)) {
          reject(
            createRouterError<NavigationRedirectError>(
              ErrorTypes.NAVIGATION_GUARD_REDIRECT,
              {
                from: to,
                to: valid,
              }
            )
          )
        } else {
          //  若 valid 是函数（beforeRouteEnter 的 next(vm => {})），存入 enterCallbacks
          if (
            enterCallbackArray &&
            // since enterCallbackArray is truthy, both record and name also are
            record!.enterCallbacks[name!] === enterCallbackArray &&
            typeof valid === 'function'
          ) {
            enterCallbackArray.push(valid)
          }
          resolve() // 放行导航
        }
      }

      // wrapping with Promise.resolve allows it to work with both async and sync guards
      // 执行守卫：绑定上下文 + 传入 to/from/next
      const guardReturn = runWithContext(() =>
        guard.call(
          record && record.instances[name!],
          to,
          from,
          __DEV__
            ? withDeprecationWarning(canOnlyBeCalledOnce(next, to, from))
            : next
        )
      )

      // 统一转为 Promise（兼容同步/异步守卫）
      let guardCall = Promise.resolve(guardReturn)

      // 若守卫参数数量 < 3（未接收 next），自动调用 next()
      if (guard.length < 3) guardCall = guardCall.then(next)

      if (__DEV__ && guard.length > 2) {
        const message = `The "next" callback was never called inside of ${
          guard.name ? '"' + guard.name + '"' : ''
        }:\n${guard.toString()}\n. If you are returning a value instead of calling "next", make sure to remove the "next" parameter from your function.`
        if (typeof guardReturn === 'object' && 'then' in guardReturn) {
          guardCall = guardCall.then(resolvedValue => {
            // @ts-expect-error: _called is added at canOnlyBeCalledOnce
            if (!next._called) {
              warn(message)
              return Promise.reject(new Error('Invalid navigation guard'))
            }
            return resolvedValue
          })
        } else if (guardReturn !== undefined) {
          // @ts-expect-error: _called is added at canOnlyBeCalledOnce
          if (!next._called) {
            warn(message)
            reject(new Error('Invalid navigation guard'))
            return
          }
        }
      }
      // 捕获守卫执行过程中的所有错误，统一 reject
      guardCall.catch(err => reject(err))
    })
}

/**
 * Wraps the next callback to warn when it is used. Dev-only: when __DEV__ is
 * false (production builds), this branch is dead code and is stripped from the
 * bundle.
 *
 * @internal
 */
function withDeprecationWarning(
  next: NavigationGuardNext
): NavigationGuardNext {
  let warned = false
  return function (this: any) {
    if (!warned) {
      warned = true
      warn(
        'The `next()` callback in navigation guards is deprecated. Return the value instead of calling `next(value)`.'
      )
    }
    return next.apply(this, arguments as any)
  }
}

function canOnlyBeCalledOnce(
  next: NavigationGuardNext,
  to: RouteLocationNormalized,
  from: RouteLocationNormalized
): NavigationGuardNext {
  let called = 0
  return function () {
    if (called++ === 1)
      warn(
        `The "next" callback was called more than once in one navigation guard when going from "${from.fullPath}" to "${to.fullPath}". It should be called exactly one time in each navigation guard. This will fail in production.`
      )
    // @ts-expect-error: we put it in the original one because it's easier to check
    next._called = true
    if (called === 1) next.apply(null, arguments as any)
  }
}

type GuardType = 'beforeRouteEnter' | 'beforeRouteUpdate' | 'beforeRouteLeave'

/**
 * 从匹配的路由记录里提取组件内路由守卫
 * @param matched 路由记录
 * @param guardType 守卫类型
 * @param to 目标路由
 * @param from 来源路由
 * @param runWithContext
 * @returns
 */
export function extractComponentsGuards(
  matched: RouteRecordNormalized[], // 路由记录
  guardType: GuardType, // 守卫类型
  to: RouteLocationNormalized, // 目标路由
  from: RouteLocationNormalizedLoaded, // 来源路由
  runWithContext: <T>(fn: () => T) => T = fn => fn()
) {
  const guards: Array<() => Promise<void>> = []

  for (const record of matched) {
    // 开发警告：无组件、无子路由
    // if (
    //   __DEV__ &&
    //   !record.components &&
    //   // in the new records, there is no children, only parents
    //   record.children &&
    //   !record.children.length
    // ) {
    //   warn(
    //     `Record with path "${record.path}" is either missing a "component(s)"` +
    //       ` or "children" property.`
    //   )
    // }

    // 遍历路由记录中的组件
    for (const name in record.components) {
      let rawComponent = record.components[name]
      // if (__DEV__) {
      //   // 警告1：组件不是合法对象/函数
      //   if (
      //     !rawComponent ||
      //     (typeof rawComponent !== 'object' &&
      //       typeof rawComponent !== 'function')
      //   ) {
      //     warn(
      //       `Component "${name}" in record with path "${record.path}" is not` +
      //         ` a valid component. Received "${String(rawComponent)}".`
      //     )
      //     // throw to ensure we stop here but warn to ensure the message isn't
      //     // missed by the user
      //     throw new Error('Invalid route component')

      //     // 警告2：异步组件写成 import() 而非 () => import()
      //   } else if ('then' in rawComponent) {
      //     // warn if user wrote import('/component.vue') instead of () =>
      //     // import('./component.vue')
      //     warn(
      //       `Component "${name}" in record with path "${record.path}" is a ` +
      //         `Promise instead of a function that returns a Promise. Did you ` +
      //         `write "import('./MyPage.vue')" instead of ` +
      //         `"() => import('./MyPage.vue')" ? This will break in ` +
      //         `production if not fixed.`
      //     )
      //     const promise = rawComponent
      //     rawComponent = () => promise

      //     // 警告3：误用 defineAsyncComponent 包裹异步组件
      //   } else if (
      //     (rawComponent as any).__asyncLoader &&
      //     // warn only once per component
      //     !(rawComponent as any).__warnedDefineAsync
      //   ) {
      //     ;(rawComponent as any).__warnedDefineAsync = true
      //     warn(
      //       `Component "${name}" in record with path "${record.path}" is defined ` +
      //         `using "defineAsyncComponent()". ` +
      //         `Write "() => import('./MyPage.vue')" instead of ` +
      //         `"defineAsyncComponent(() => import('./MyPage.vue'))".`
      //     )
      //   }
      // }

      // TODO: extract the logic relying on instances into an options-api plugin
      // skip update and leave guards if the route component is not mounted
      // 非 beforeRouteEnter 守卫，且组件未挂载 → 跳过（无实例无法执行）
      if (guardType !== 'beforeRouteEnter' && !record.instances[name]) continue

      // 判断是否为同步组件
      if (isRouteComponent(rawComponent)) {
        // __vccOpts is added by vue-class-component and contain the regular options
        const options: ComponentOptions =
          // 兼容 vue-class-component 装饰器写法的组件选项
          (rawComponent as any).__vccOpts || rawComponent

        // 获取组件内路由守卫
        const guard = options[guardType]

        guard &&
          guards.push(
            // 将守卫函数封装为 Promise 格式
            guardToPromiseFn(guard, to, from, record, name, runWithContext)
          )
      } else {
        // start requesting the chunk already
        // 执行懒加载函数，开始加载组件
        let componentPromise: Promise<
          RouteComponent | null | undefined | void
        > = (rawComponent as Lazy<RouteComponent>)()

        // 开发环境警告：懒加载函数未返回 Promise
        // if (__DEV__ && !('catch' in componentPromise)) {
        //   warn(
        //     `Component "${name}" in record with path "${record.path}" is a function that does not return a Promise. If you were passing a functional component, make sure to add a "displayName" to the component. This will break in production if not fixed.`
        //   )
        //   componentPromise = Promise.resolve(componentPromise as RouteComponent)
        // }

        guards.push(() =>
          componentPromise.then(resolved => {
            if (!resolved)
              throw new Error(
                `Couldn't resolve component "${name}" at "${record.path}"`
              )
            const resolvedComponent = isESModule(resolved)
              ? resolved.default
              : resolved
            // keep the resolved module for plugins like data loaders
            // 缓存已加载组件
            record.mods[name] = resolved
            // replace the function with the resolved component
            // cannot be null or undefined because we went into the for loop
            // 替换组件为已加载组件
            record.components![name] = resolvedComponent
            // __vccOpts is added by vue-class-component and contain the regular options
            //
            const options: ComponentOptions =
              (resolvedComponent as any).__vccOpts || resolvedComponent

            const guard = options[guardType]

            return (
              guard &&
              guardToPromiseFn(guard, to, from, record, name, runWithContext)()
            )
          })
        )
      }
    }
  }

  return guards
}

/**
 * Ensures a route is loaded, so it can be passed as o prop to `<RouterView>`.
 *
 * @param route - resolved route to load
 */
export function loadRouteLocation(
  route: RouteLocation | RouteLocationNormalized
): Promise<RouteLocationNormalizedLoaded> {
  return route.matched.every(record => record.redirect)
    ? Promise.reject(new Error('Cannot load a route that redirects.'))
    : Promise.all(
        route.matched.map(
          record =>
            record.components &&
            Promise.all(
              Object.keys(record.components).reduce(
                (promises, name) => {
                  const rawComponent = record.components![name]
                  if (
                    typeof rawComponent === 'function' &&
                    !('displayName' in rawComponent)
                  ) {
                    promises.push(
                      (rawComponent as Lazy<RouteComponent>)().then(
                        resolved => {
                          if (!resolved)
                            return Promise.reject(
                              new Error(
                                `Couldn't resolve component "${name}" at "${record.path}". Ensure you passed a function that returns a promise.`
                              )
                            )

                          const resolvedComponent = isESModule(resolved)
                            ? resolved.default
                            : resolved
                          // keep the resolved module for plugins like data loaders
                          record.mods[name] = resolved
                          // replace the function with the resolved component
                          // cannot be null or undefined because we went into the for loop
                          record.components![name] = resolvedComponent
                          return
                        }
                      )
                    )
                  }
                  return promises
                },
                [] as Array<Promise<RouteComponent | null | undefined>>
              )
            )
        )
      ).then(() => route as RouteLocationNormalizedLoaded)
}

/**
 * Split the leaving, updating, and entering records.
 * @internal
 *
 * @param  to - Location we are navigating to 目标
 * @param from - Location we are navigating from 来源
 */
export function extractChangingRecords(
  to: RouteLocationNormalized,
  from: RouteLocationNormalizedLoaded
): [
  leavingRecords: RouteRecordNormalized[],
  updatingRecords: RouteRecordNormalized[],
  enteringRecords: RouteRecordNormalized[],
] {
  const leavingRecords: RouteRecordNormalized[] = []
  const updatingRecords: RouteRecordNormalized[] = []
  const enteringRecords: RouteRecordNormalized[] = []

  const len = Math.max(from.matched.length, to.matched.length)
  for (let i = 0; i < len; i++) {
    const recordFrom = from.matched[i] // 来源记录

    // 来源记录存在
    if (recordFrom) {
      if (to.matched.find(record => isSameRouteRecord(record, recordFrom)))
        // 路径相同，记录为更新记录
        updatingRecords.push(recordFrom)
      // 路径不同，记录为离开记录
      else leavingRecords.push(recordFrom)
    }

    // 目标记录存在
    const recordTo = to.matched[i]
    if (recordTo) {
      // the type doesn't matter because we are comparing per reference
      if (!from.matched.find(record => isSameRouteRecord(record, recordTo))) {
        // 路径不同，记录为进入记录
        enteringRecords.push(recordTo)
      }
    }
  }

  return [leavingRecords, updatingRecords, enteringRecords]
}
