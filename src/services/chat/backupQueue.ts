/**
 * 导入、导出、全部删除与跨设备同步共用一条串行队列，
 * 避免读取归档或同步快照时数据被另一个事务改写。
 */
let backupQueue: Promise<unknown> = Promise.resolve()

export const enqueueBackup = <T>(run: () => Promise<T>): Promise<T> => {
  const task = backupQueue.then(run)
  backupQueue = task.catch(() => {})
  return task
}
