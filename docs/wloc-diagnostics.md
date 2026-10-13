# 核对响应是否真正改写

本次修改修正了条目计数误报和 Synthetic 封包丢失尾部数据的问题，并增加了输出校验。**尚无真实 Apple 响应捕获样本，也未确认这次修改能让真实 iPhone 的苹果地图采用目标位置。** 所有回归输入均为模拟数据；不能把自动化测试通过理解为真机定位成功。

## 在 iPhone 上查看新诊断

更新实际部署的 `location-spoofer.js`，让 Shadowrocket 重新加载脚本。使用原有模块的 `debug=true`，触发一次定位，检查新的 `scanned`、`modified`、`outputVerified` 日志。旧版 `Patched N Wi-Fi` 日志表示仍在运行旧脚本。GitHub 推送本身不证明 Cloudflare 已完成部署。

示例计数仅用于解释日志，并非真实设备结果：

```text
[Location Spoofer] Format: synthetic; scanned Wi-Fi=2 Cell=1; modified Wi-Fi=1 Cell=1 latitude=2 longitude=2; verified records before=0 after=2/2 outputVerified=true coverageComplete=false; bytes=120->124 delta=4; unsupported=1 malformed=0; coordWire varint=4 fixed64=0 fixed32=0 other=0
```

| 项目 | 含义 |
| --- | --- |
| `scanned Wi-Fi/Cell` | 已扫描的根级 Wi-Fi/基站条目数；不是修改成功数。旧的 `wifiCount`、`cellCount` 和对应响应头保留此含义。 |
| `modified Wi-Fi/Cell` | 至少一个经纬度字段字节发生变化的条目数。 |
| `modified latitude/longitude` | 重新编码后确实发生字节变化的纬度/经度字段数；已经是目标坐标时可为 0。 |
| `verified records before/after` | 在支持的结构中，改写前/后已经匹配目标坐标对的记录数；`after=N/N` 表示这些记录全部匹配。 |
| `outputVerified` | 最终输出按预期格式重新解包、payload 字节一致、所有支持的坐标记录均匹配目标值。此标志不能证明 iOS 接受响应，也不能验证未知字段中的坐标。 |
| `coverageComplete` | 至少识别出一条支持的记录，且未发现不支持或解析失败的 Wi-Fi/基站记录。它只描述当前实现识别的字段路径。 |
| `bytes` / `delta` | 整个二进制响应改写前后长度和差值。Varint 长度可以随数值变化，不能要求长度差恒为 0。 |
| `unsupported` / `malformed` | 未找到支持的坐标结构或解析失败的记录数；这些记录保留原始数据。 |
| `coordWire` | 在预期 Location 消息中遇到的字段 1/2 的 wire type 计数。它不包含坐标数值。 |

如果 `scanned` 很大但 `modified=0`，先看 `before/after`。记录原本已经匹配目标值时，0 次修改是正常的；如果 `outputVerified=false`、`unsupported` 很大或 `coordWire fixed64` 非零，则当前字段结构无法确认。没有支持的坐标记录时，脚本透传原始响应，不再报告成功改写。

如果 `outputVerified=true`、`coverageComplete=true` 且所有支持的记录均匹配，但地图依旧显示真实位置，只能说明此解析器中的输出字节检查通过。响应结构是否符合这台设备、iOS 是否采用该响应以及最终地图行为仍需真机验证，不能仅从此日志推断原因。

## 已验证的代码路径与未验证的协议假设

已用模拟回归验证：经纬度实际修改计数；原本是目标坐标时的零计数；负数/零/边界坐标的独立 int64 编解码；未知 wire type、重复字段和错误嵌套的保留；Synthetic/Marker/ARPC 尾部保留；bare protobuf 原封装保留；长度溢出拦截；最终输出再次解包；异常结构与日志脱敏。

当前支持的协议假设：

- Wi-Fi：根字段 2 → Location 子消息字段 2 → 纬度字段 1、经度字段 2。
- 基站：保留仓库原有根字段 22/24 → Location 子消息字段 5。
- 纬度与经度采用 protobuf `int64` varint（wire type 0），缩放为 `round(degrees × 10⁸)`；不按 `sint64` ZigZag、fixed64 double 或其它嵌套结构猜测改写。
- 保留坐标以外的字段；原有水平精度字段 3 使用原有改写规则。Synthetic/Marker 长度字段使用 16 位长度，溢出时阻止发送损坏的回包。

研究来源：[BSSIDApple.proto](https://github.com/acheong08/apple-corelocation-experiments/blob/0b136860e80585c02c12f64933995b872d7623af/pb/BSSIDApple.proto) 记录了 Wi-Fi 和根字段 22 的上述结构；[lib/wloc.go](https://github.com/acheong08/apple-corelocation-experiments/blob/0b136860e80585c02c12f64933995b872d7623af/lib/wloc.go) 使用 10⁸ 的坐标缩放。它们是第三方协议研究，**不是 Apple 官方保证，也不是本次真机样本证据**。字段 24 沿用已有实现，未由该 schema 或本次真机样本独立确认。没有复制这些项目的实现代码或原始数据。

对于未知 raw 容器，滑窗扫描即使找到了支持的坐标，也无法确认外层长度和尾部语义。运行时保留完整原响应并报告 `Unknown raw envelope framing`，不把猜测的 Synthetic 封包发送给 iOS。输出校验失败时遵守原有 `failOpen` 设置：默认透传；明确配置 `failOpen=false` 时返回经过脱敏的错误原因。

## 重跑检查

在仓库根目录运行：

```sh
node --test tests/wloc.test.cjs tests/shadowrocket.test.cjs
node --check location-spoofer.js
node --check public/location-spoofer.js
git diff --check
```

`tests/wloc.test.cjs` 明确使用独立构造的模拟封包和 BigInt 测试解码器；生产脚本保持不依赖 BigInt。`tests/shadowrocket.test.cjs` 保存了上一轮的模拟运行时回归检查。没有真实响应 fixture，也没有跳过的“真实样本测试”被算作通过。

## 隐私与下一步证据

先提供新版本的聚合诊断日志即可，本次不要求导出完整定位请求或二进制响应。日志只包含计数、格式、wire type、长度和固定失败原因，不输出 TOKEN、配置 URL、坐标、BSSID、基站标识或完整响应内容。

如果聚合诊断仍无法识别结构，再单独安排响应样本采集。真实 Apple 定位响应可能含有附近 Wi-Fi BSSID、基站标识、坐标、时间和设备上下文；请求还可能含应用/设备信息。采集前应确认所用 Shadowrocket 版本是否能仅保存二进制响应正文，并明确保存位置和范围；不同版本的具体操作入口未在本次核实。不得通过日志打印、公开 Issue、Git 提交或第三方上传分享完整抓包。需要保留 Protobuf 字段类型、长度及封包尾部，不能简单用文本替换做脱敏；原件应留在用户本机，提供经过结构保持脱敏的离线副本后再增加真实样本回归。
