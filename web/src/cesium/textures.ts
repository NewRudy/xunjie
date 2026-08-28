// Canvas 程序化纹理：光伏板阵列（深蓝底 + 浅蓝栅格线，模拟组件排布感）
export function makePvPanelCanvas(): HTMLCanvasElement {
  const size = 128
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')!

  // 板面底色（深蓝）
  ctx.fillStyle = '#16304f'
  ctx.fillRect(0, 0, size, size)

  // 电池片栅格
  ctx.strokeStyle = '#2b5b8a'
  ctx.lineWidth = 2
  const cell = 16
  for (let i = 0; i <= size; i += cell) {
    ctx.beginPath()
    ctx.moveTo(i, 0)
    ctx.lineTo(i, size)
    ctx.stroke()
    ctx.beginPath()
    ctx.moveTo(0, i)
    ctx.lineTo(size, i)
    ctx.stroke()
  }

  // 板间缝（更亮的边线）
  ctx.strokeStyle = '#4f7fb5'
  ctx.lineWidth = 4
  ctx.strokeRect(0, 0, size, size)

  return canvas
}
