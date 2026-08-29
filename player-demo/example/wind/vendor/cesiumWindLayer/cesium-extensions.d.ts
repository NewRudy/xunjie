declare module 'cesium' {
  export class ShaderSource {
    constructor(options: {
      sources: string[];
      defines?: string[];
    });
  }

  export class ShaderProgram {
    static fromCache(options: {
      context: any;
      vertexShaderSource: ShaderSource;
      fragmentShaderSource: ShaderSource;
      attributeLocations?: { [key: string]: number };
    }): ShaderProgram;
    destroy(): void;
  }

  export class VertexArray {
    static fromGeometry(options: {
      context: any;
      geometry: Geometry;
      attributeLocations?: { [key: string]: number };
      bufferUsage: BufferUsage;
    }): VertexArray;
    destroy(): void;
  }

  export class Framebuffer {
    constructor(options: {
      context: any;
      colorTextures: Texture[];
      depthTexture: Texture;
    });
    getColorTexture(index: number): Texture;
    depthTexture: Texture;
  }

  export enum BufferUsage {
    STATIC_DRAW,
    DYNAMIC_DRAW
  }

  export class DrawCommand {
    constructor(options: {
      owner: any;
      vertexArray?: VertexArray;
      primitiveType?: PrimitiveType;
      modelMatrix?: Matrix4;
      renderState?: any;
      framebuffer?: any;
      shaderProgram: ShaderProgram;
      uniformMap: { [key: string]: () => any };
      pass: Pass;
      cull?: boolean;
    });
    uniformMap: { [key: string]: () => any };
    shaderProgram?: ShaderProgram;
    vertexArray?: VertexArray;
    framebuffer?: Framebuffer;
    outputTexture?: Texture;
  }

  export class ComputeCommand {
    constructor(options: {
      owner: any;
      fragmentShaderSource: ShaderSource;
      uniformMap: { [key: string]: () => any };
      outputTexture: Texture;
      persists: boolean;
    });
    uniformMap: { [key: string]: () => any };
    shaderProgram?: ShaderProgram;
    vertexArray?: VertexArray;
    framebuffer?: Framebuffer;
    outputTexture?: Texture;
  }

  export class ClearCommand {
    constructor(options: {
      color: Color;
      depth: number;
      framebuffer?: any;
      pass: Pass;
    });
    framebuffer?: Framebuffer;
    execute(context: any): void;
  }

  export class RenderState {
    static fromCache(options: any): any;
  }

  export enum Pass {
    OPAQUE,
    TRANSLUCENT,
    COMPUTE,
    OVERLAY
  }

  export enum PrimitiveType {
    POINTS,
    LINES,
    TRIANGLES
  }

  export enum ComponentDatatype {
    FLOAT
  }

  export class Texture {
    constructor(options: {
      context: any;
      width: number;
      height: number;
      pixelFormat: PixelFormat;
      pixelDatatype: PixelDatatype;
      source?: {
        width?: number;
        height?: number;
        arrayBufferView: Uint8Array | Float32Array;
      };
      sampler?: Sampler;
    });
    copyFrom(options: { source: ArrayBufferView | ImageData | HTMLImageElement | HTMLCanvasElement | HTMLVideoElement }): void;
    destroy(): void;
  }

  export enum TextureWrap {
    CLAMP_TO_EDGE,
    REPEAT,
    MIRRORED_REPEAT,
  }

  export class Sampler {
    constructor(options: {
      minificationFilter?: TextureMinificationFilter;
      magnificationFilter?: TextureMagnificationFilter;
      wrapS?: TextureWrap;
      wrapT?: TextureWrap;
    });
  }

  export enum TextureMinificationFilter {
    NEAREST,
    LINEAR
  }

  export enum TextureMagnificationFilter {
    NEAREST,
    LINEAR
  }

  export enum PixelFormat {
    RGBA
  }

  export enum PixelDatatype {
    UNSIGNED_BYTE,
    FLOAT
  }

  export interface Scene {
    context: any;
    frameStateNormal: any;
    postRender: Event;
    requestRender(): void;
  }

  export class Event {
    addEventListener(listener: (...args: any[]) => void, scope?: any): (...args: any[]) => void;
    removeEventListener(listener: (...args: any[]) => void, scope?: any): boolean;
    raiseEvent(...args: any[]): void;
  }

}
