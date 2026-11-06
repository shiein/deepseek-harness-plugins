/**
 * 经自有 remote 通道还原的跨源业务请求（方案 §0.3 第 10 条）。响应层登记，Mock 与 worker 据此把它们只交给
 * fixture 匹配或明确未命中，绝不当作项目资源下发或转发。仅进程内标记，无副作用。
 */
export const remoteRequests = new WeakSet<object>()
