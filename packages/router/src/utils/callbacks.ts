/**
 * Create a list of callbacks that can be reset. Used to create before and after navigation guards list
 */
export function useCallbacks<T>() {
  let handlers: T[] = []

  function add(handler: T): () => void {
    // 添加回调函数
    handlers.push(handler)

    // 移除指定回调函数，确保只移除一次
    return () => {
      const i = handlers.indexOf(handler)
      if (i > -1) handlers.splice(i, 1)
    }
  }

  function reset() {
    handlers = []
  }

  return {
    add,
    list: () => handlers.slice(),
    reset,
  }
}
