export const updatePositionShader = /*glsl*/`#version 300 es
precision highp float;

uniform sampler2D currentParticlesPosition;
uniform sampler2D particlesSpeed;

in vec2 v_textureCoordinates;

out vec4 fragColor;

void main() {
    // 获取当前粒子的位置
    vec2 currentPos = texture(currentParticlesPosition, v_textureCoordinates).rg;
    // 获取粒子的速度
    vec2 speed = texture(particlesSpeed, v_textureCoordinates).rg;
    // 计算下一个位置
    vec2 nextPos = currentPos + speed;

    // 将新的位置写入 fragColor
    fragColor = vec4(nextPos, 0.0, 0.0);
}
`;
