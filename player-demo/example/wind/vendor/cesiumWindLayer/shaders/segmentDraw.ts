export const renderParticlesVertexShader = /*glsl*/`#version 300 es
precision highp float;

in vec2 st;
in vec3 normal;

uniform sampler2D previousParticlesPosition;
uniform sampler2D currentParticlesPosition;
uniform sampler2D postProcessingPosition;
uniform sampler2D particlesSpeed;

uniform vec2 lineWidth;
uniform vec2 lineLength;
uniform vec2 domain;
uniform vec2 viewport;
uniform vec4 windBounds;
uniform vec2 windCornerSW;
uniform vec2 windCornerSE;
uniform vec2 windCornerNW;
uniform vec2 windCornerNE;

// 添加输出变量传递给片元着色器
out vec4 speed;
out float v_segmentPosition;

// 添加结构体定义
struct adjacentPoints {
    vec4 previous;
    vec4 current;
    vec4 next;
};

vec4 calculateProjectedCoordinate(vec2 lonLat) {
    vec2 range = max(windBounds.zw - windBounds.xy, vec2(0.000001));
    vec2 uv = clamp((lonLat - windBounds.xy) / range, 0.0, 1.0);
    vec2 southEdge = mix(windCornerSW, windCornerSE, uv.x);
    vec2 northEdge = mix(windCornerNW, windCornerNE, uv.x);
    return vec4(mix(southEdge, northEdge, uv.y), 0.0, 1.0);
}

void main() {
    // 翻转 Y 轴坐标
    vec2 flippedIndex = vec2(st.x, 1.0 - st.y);

    vec2 particleIndex = flippedIndex;
    speed = texture(particlesSpeed, particleIndex);

    vec2 previousPosition = texture(previousParticlesPosition, particleIndex).rg;
    vec2 currentPosition = texture(currentParticlesPosition, particleIndex).rg;
    vec2 nextPosition = texture(postProcessingPosition, particleIndex).rg;

    float isAnyRandomPointUsed = texture(postProcessingPosition, particleIndex).a +
        texture(currentParticlesPosition, particleIndex).a +
        texture(previousParticlesPosition, particleIndex).a;

    adjacentPoints projectedCoordinates;
    if (isAnyRandomPointUsed > 0.0) {
        projectedCoordinates.previous = calculateProjectedCoordinate(previousPosition);
        projectedCoordinates.current = projectedCoordinates.previous;
        projectedCoordinates.next = projectedCoordinates.previous;
    } else {
        projectedCoordinates.previous = calculateProjectedCoordinate(previousPosition);
        projectedCoordinates.current = calculateProjectedCoordinate(currentPosition);
        projectedCoordinates.next = calculateProjectedCoordinate(nextPosition);
    }

    float speedLength = clamp(speed.b, domain.x, domain.y);
    float normalizedSpeed = clamp(
        (speedLength - domain.x) / max(domain.y - domain.x, 0.0001),
        0.0,
        1.0
    );

    vec2 currentNdc = projectedCoordinates.current.xy / projectedCoordinates.current.w;
    vec2 nextNdc = projectedCoordinates.next.xy / projectedCoordinates.next.w;
    vec2 directionPixels = (nextNdc - currentNdc) * viewport;
    float directionLength = length(directionPixels);
    vec2 direction = directionLength > 0.0001
        ? directionPixels / directionLength
        : vec2(1.0, 0.0);
    vec2 normalDirection = vec2(-direction.y, direction.x);
    vec2 pixelToNdc = 2.0 / max(viewport, vec2(1.0));
    float lengthPixels = mix(lineLength.x, lineLength.y, normalizedSpeed);
    float widthPixels = mix(lineWidth.x, lineWidth.y, normalizedSpeed);
    float alongSign = normal.x;
    float acrossSign = normal.y;
    vec2 particleNdc = currentNdc
        + direction * alongSign * lengthPixels * 0.5 * pixelToNdc
        + normalDirection * acrossSign * widthPixels * pixelToNdc;

    gl_Position = vec4(
        particleNdc * projectedCoordinates.current.w,
        projectedCoordinates.current.z,
        projectedCoordinates.current.w
    );
    v_segmentPosition = alongSign * 0.5 + 0.5;


}
`;

export const renderParticlesFragmentShader = /*glsl*/`#version 300 es
precision highp float;

in vec4 speed;
in float v_segmentPosition;

uniform vec2 domain;
uniform vec2 displayRange;
uniform sampler2D colorTable;

layout(location = 0) out vec4 out_FragColor;

void main() {
    const float zero = 0.0;
    if (speed.a > zero && speed.b > displayRange.x && speed.b < displayRange.y) {
        float speedLength = clamp(speed.b, domain.x, domain.y);
        float normalizedSpeed = clamp(
            (speedLength - domain.x) / max(domain.y - domain.x, 0.0001),
            0.0,
            1.0
        );
        vec4 baseColor = texture(colorTable, vec2(normalizedSpeed, zero));
        float alpha = pow(smoothstep(0.0, 1.0, v_segmentPosition), 1.35);
        float speedAlpha = mix(0.35, 1.0, speed.a);
        out_FragColor = vec4(baseColor.rgb, baseColor.a * alpha * speedAlpha);
    } else {
        out_FragColor = vec4(zero);
    }

}
`;
