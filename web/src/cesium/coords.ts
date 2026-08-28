// ENU 局部坐标 ↔ Cesium 世界坐标转换。
// fixture 中所有 position 为以 anchor 为原点的 ENU 米坐标（x 东、y 北、z 高），
// 通过 eastNorthUpToFixedFrame 摆到 WGS84 椭球上（锚点海拔 1280m）。
import * as Cesium from 'cesium'
import { fixture } from '../fixture'

const anchor = fixture.anchor

export const anchorCartesian = Cesium.Cartesian3.fromDegrees(anchor.lon, anchor.lat, anchor.altM)

/** ENU → ECEF 变换矩阵 */
export const enuMatrix = Cesium.Transforms.eastNorthUpToFixedFrame(anchorCartesian)

/** ENU 局部米坐标 → Cesium 世界坐标 */
export function enuToWorld(x: number, y: number, z = 0): Cesium.Cartesian3 {
  return Cesium.Matrix4.multiplyByPoint(enuMatrix, new Cesium.Cartesian3(x, y, z), new Cesium.Cartesian3())
}

export function enuToWorldArray(points: [number, number][], z = 0): Cesium.Cartesian3[] {
  return points.map(([x, y]) => enuToWorld(x, y, z))
}

/** 矩形四角（中心 + 尺寸），按逆时针返回 */
export function rectCorners(cx: number, cy: number, w: number, h: number): [number, number][] {
  return [
    [cx - w / 2, cy - h / 2],
    [cx + w / 2, cy - h / 2],
    [cx + w / 2, cy + h / 2],
    [cx - w / 2, cy + h / 2],
  ]
}
