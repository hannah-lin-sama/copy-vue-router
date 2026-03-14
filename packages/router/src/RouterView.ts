import {
  h,
  inject,
  provide,
  defineComponent,
  PropType,
  ref,
  unref,
  ComponentPublicInstance,
  VNodeProps,
  getCurrentInstance,
  computed,
  AllowedComponentProps,
  ComponentCustomProps,
  watch,
  Slot,
  VNode,
  Component,
} from 'vue'
import type {
  RouteLocationNormalized,
  RouteLocationNormalizedLoaded,
} from './typed-routes'
import type { RouteLocationMatched } from './types'
import {
  matchedRouteKey,
  viewDepthKey,
  routerViewLocationKey,
} from './injectionSymbols'
import { assign, isArray, isBrowser } from './utils'
import { warn } from './warning'
import { isSameRouteRecord } from './location'

export interface RouterViewProps {
  name?: string
  // allow looser type for user facing api
  route?: RouteLocationNormalized
}

export interface RouterViewDevtoolsContext extends Pick<
  RouteLocationMatched,
  'path' | 'name' | 'meta'
> {
  depth: number
}

export const RouterViewImpl = /*#__PURE__*/ defineComponent({
  name: 'RouterView',
  // #674 we manually inherit them
  inheritAttrs: false, // 禁用属性继承，避免 attrs 透传到子组件（手动控制）
  props: {
    // 命名视图名称
    name: {
      type: String as PropType<string>,
      default: 'default',
    },
    // 手动指定渲染的路由
    route: Object as PropType<RouteLocationNormalizedLoaded>,
  },

  // Better compat for @vue/compat users
  // https://github.com/vuejs/router/issues/1315
  // 兼容 @vue/compat 模式
  compatConfig: { MODE: 3 },

  // Setup 阶段：核心依赖注入 + 响应式计算
  setup(props, { attrs, slots }) {
    __DEV__ && warnDeprecatedUsage()

    // 获取路由信息
    // Vue Router 插件在应用初始化时通过 app.provide(routerViewLocationKey, 路由信息) 注册
    const injectedRoute = inject(routerViewLocationKey)!
    // 获取最后要渲染的路由
    const routeToDisplay = computed<RouteLocationNormalizedLoaded>(
      // 若父组件给 <RouterView> 传入了 route props（如 <RouterView :route="customRoute" />），则使用该自定义路由
      () => props.route || injectedRoute.value
    )

    // 父级传递的深度（默认 0）
    const injectedDepth = inject(viewDepthKey, 0)

    // The depth changes based on empty components option, which allows passthrough routes e.g. routes with children
    // that are used to reuse the `path` property
    // 响应式计算：确定渲染的路由与深度
    const depth = computed<number>(() => {
      let initialDepth = unref(injectedDepth) // 解包初始深度（处理响应式值）

      // 获取当前要渲染的路由的 matched 数组（嵌套路由记录）
      const { matched } = routeToDisplay.value
      let matchedRoute: RouteLocationMatched | undefined
      while (
        (matchedRoute = matched[initialDepth]) &&
        !matchedRoute.components
      ) {
        initialDepth++ // 跳过空路由，深度 +1
      }
      return initialDepth // 返回最终实际渲染深度
    })

    // 根据深度获取要渲染的路由记录
    const matchedRouteRef = computed<RouteLocationMatched | undefined>(
      () => routeToDisplay.value.matched[depth.value]
    )

    // 注入当前深度 + 1 作为子视图的深度
    provide(
      viewDepthKey,
      computed(() => depth.value + 1)
    )
    provide(matchedRouteKey, matchedRouteRef) // 提供当前匹配的路由记录
    provide(routerViewLocationKey, routeToDisplay) // 提供当前路由信息

    const viewRef = ref<ComponentPublicInstance>()

    // watch at the same time the component instance, the route record we are
    // rendering, and the name
    // 实例管理：监听组件实例 & 路由守卫回调
    watch(
      // 监听<RouterView> 渲染的组件实例
      // 监听当前匹配的路由记录
      // 监听命名视图名称
      () => [viewRef.value, matchedRouteRef.value, props.name] as const,
      // 新值：[instance, to, name]（新组件实例、新路由记录、当前视图名称）
      // 旧值：[oldInstance, from, oldName]（旧组件实例、旧路由记录、旧视图名称）
      ([instance, to, name], [oldInstance, from, oldName]) => {
        // copy reused instances
        if (to) {
          // this will update the instance for new instances as well as reused
          // instances when navigating to a new route
          to.instances[name] = instance
          // the component instance is reused for a different route or name, so
          // we copy any saved update or leave guards. With async setup, the
          // mounting component will mount before the matchedRoute changes,
          // making instance === oldInstance, so we check if guards have been
          // added before. This works because we remove guards when
          // unmounting/deactivating components
          // 组件实例被复用于不同路由/名称的场景：拷贝守卫
          if (from && from !== to && instance && instance === oldInstance) {
            // 拷贝离开守卫（leaveGuards）
            if (!to.leaveGuards.size) {
              to.leaveGuards = from.leaveGuards
            }
            // 拷贝更新守卫（updateGuards）
            if (!to.updateGuards.size) {
              to.updateGuards = from.updateGuards
            }
          }
        }

        // trigger beforeRouteEnter next callbacks
        if (
          instance &&
          to &&
          // if there is no instance but to and from are the same this might be
          // the first visit
          // 无旧实例/新旧路由记录不同/无旧路由记录 → 首次访问/路由切换
          (!from || !isSameRouteRecord(to, from) || !oldInstance)
        ) {
          // 触发 beforeRouteEnter 回调
          ;(to.enterCallbacks[name] || []).forEach(callback =>
            callback(instance)
          )
        }
      },
      { flush: 'post' } // 后置刷新：DOM 更新后执行
    )

    // 渲染阶段：生成组件 VNode & 处理插槽
    return () => {
      const route = routeToDisplay.value // 获取当前要渲染的路
      // we need the value at the time we render because when we unmount, we
      // navigated to a different location so the value is different
      const currentName = props.name // 保存渲染时的命名视图名称（
      const matchedRoute = matchedRouteRef.value // 获取匹配的路由记录

      // 按命名视图获取要渲染的组件
      const ViewComponent =
        matchedRoute && matchedRoute.components![currentName]

      // 无匹配组件：渲染默认插槽（传递空 Component 和路由）
      if (!ViewComponent) {
        return normalizeSlot(slots.default, { Component: ViewComponent, route })
      }

      // props from route configuration
      // 从路由记录中获取命名视图对应的 props 配置
      const routePropsOption = matchedRoute.props[currentName]

      // 解析路由 props：支持 4 种配置方式
      const routeProps = routePropsOption
        ? // 方式1：true → 传递 route.params 作为 props
          routePropsOption === true
          ? route.params
          : typeof routePropsOption === 'function'
            ? // 方式2：函数 → 执行函数返回 props
              routePropsOption(route)
            : // 方式3：对象 → 直接传递该对象
              routePropsOption
        : // 方式4：无配置 → 不传 props
          null

      const onVnodeUnmounted: VNodeProps['onVnodeUnmounted'] = vnode => {
        // remove the instance reference to prevent leak
        // 组件已卸载时，清空路由记录中的实例引用
        if (vnode.component!.isUnmounted) {
          matchedRoute.instances[currentName] = null
        }
      }

      // 创建组件 VNode
      const component = h(
        ViewComponent, // 要渲染的组件
        // 合并 props：路由 props → 组件 attrs → 自定义属性
        assign({}, routeProps, attrs, {
          onVnodeUnmounted,
          ref: viewRef,
        })
      )

      if (
        (__DEV__ || __FEATURE_PROD_DEVTOOLS__) &&
        isBrowser &&
        component.ref
      ) {
        // TODO: can display if it's an alias, its props
        const info: RouterViewDevtoolsContext = {
          depth: depth.value,
          name: matchedRoute.name,
          path: matchedRoute.path,
          meta: matchedRoute.meta,
        }

        const internalInstances = isArray(component.ref)
          ? component.ref.map(r => r.i)
          : [component.ref.i]

        internalInstances.forEach(instance => {
          // @ts-expect-error
          instance.__vrv_devtools = info
        })
      }

      // 优先插槽（传递 Component VNode 和 route），否则直接渲染组件
      return (
        // pass the vnode to the slot as a prop.
        // h and <component :is="..."> both accept vnodes
        normalizeSlot(slots.default, { Component: component, route }) ||
        component
      )
    }
  },
})

/**
 * 标准化 Vue 作用域插槽（Scoped Slot）输出
 * @param slot Vue 中的作用域插槽（Scoped Slot） 本质是一个函数
 * @param data 作用域数据，包含 Component VNode 和 route
 * @returns 标准化后的插槽内容（VNode/VNode 数组）
 */
function normalizeSlot(slot: Slot | undefined, data: any) {
  if (!slot) return null

  // 执行插槽函数，传入作用域数据，获取插槽内容（VNode/VNode 数组）
  const slotContent = slot(data)

  // 标准化返回值：单元素数组 → 单个 VNode，否则返回原数组
  return slotContent.length === 1 ? slotContent[0] : slotContent
}

// export the public type for h/tsx inference
// also to avoid inline import() in generated d.ts files
/**
 * Component to display the current route the user is at.
 */
export const RouterView = RouterViewImpl as unknown as {
  new (): {
    // AllowedComponentProps	Vue 允许的基础组件属性（如 id/style）
    $props: AllowedComponentProps &
      // ComponentCustomProps	全局自定义 Props（如 app.config.globalProperties 扩展的属性）
      ComponentCustomProps &
      // NodeProps	Vue 内置 VNode 属性（如 key/ref/class）
      VNodeProps &
      // RouterViewProps	<RouterView> 专属 Props（核心）
      RouterViewProps

    $slots: {
      default?: ({
        Component, // 当前路由匹配的组件 VNode（
        route, // 当前激活的标准化路由信息
      }: {
        Component: VNode
        route: RouteLocationNormalizedLoaded // 手动指定渲染的路由（默认用当前路由）
      }) => VNode[]
    }
  }
}

// warn against deprecated usage with <transition> & <keep-alive>
// due to functional component being no longer eager in Vue 3
function warnDeprecatedUsage() {
  const instance = getCurrentInstance()!
  const parentName = instance.parent && instance.parent.type.name
  const parentSubTreeType =
    instance.parent && instance.parent.subTree && instance.parent.subTree.type
  if (
    parentName &&
    (parentName === 'KeepAlive' || parentName.includes('Transition')) &&
    typeof parentSubTreeType === 'object' &&
    (parentSubTreeType as Component).name === 'RouterView'
  ) {
    const comp = parentName === 'KeepAlive' ? 'keep-alive' : 'transition'
    warn(
      `<router-view> can no longer be used directly inside <transition> or <keep-alive>.\n` +
        `Use slot props instead:\n\n` +
        `<router-view v-slot="{ Component }">\n` +
        `  <${comp}>\n` +
        `    <component :is="Component" />\n` +
        `  </${comp}>\n` +
        `</router-view>`
    )
  }
}
