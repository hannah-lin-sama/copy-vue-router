import { inject } from 'vue'
import { routerKey, routeLocationKey } from './injectionSymbols'
import { Router } from './router'
import { RouteMap } from './typed-routes/route-map'
import { RouteLocationNormalizedLoaded } from './typed-routes'

/**
 * Returns the router instance. Equivalent to using `$router` inside
 * templates.
 */
export function useRouter(): Router {
  // const routerKey = Symbol(__DEV__ ? 'router' : '') as InjectionKey<Router>
  // 注入 router 实例
  return inject(routerKey)!
}

/**
 * Returns the current route location. Equivalent to using `$route` inside
 * templates.
 */
export function useRoute<Name extends keyof RouteMap = keyof RouteMap>(
  _name?: Name
) {
  /*
  const routeLocationKey = Symbol(
    __DEV__ ? 'route location' : ''
  ) as InjectionKey<RouteLocationNormalizedLoaded>
   */
  // 注入 route
  return inject(routeLocationKey) as RouteLocationNormalizedLoaded<
    Name | RouteMap[Name]['childrenNames']
  >
}
