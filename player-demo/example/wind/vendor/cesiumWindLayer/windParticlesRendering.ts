import { Geometry, GeometryAttribute, ComponentDatatype, PrimitiveType, GeometryAttributes, Color, Texture, Sampler, TextureMinificationFilter, TextureMagnificationFilter, PixelFormat, PixelDatatype, Framebuffer, Appearance, TextureWrap, VertexArray, BufferUsage, Cartesian2, Cartesian3, Cartesian4, SceneTransforms } from 'cesium';
import { WindLayerOptions } from './types';
import { WindParticlesComputing } from './windParticlesComputing';
import CustomPrimitive from './customPrimitive';
import { ShaderManager } from './shaderManager';
import { deepMerge } from './utils';
import { DefaultOptions } from '.';

export class WindParticlesRendering {
  private context: any;
  private options: WindLayerOptions;
  viewerParameters: any;
  private computing: WindParticlesComputing;
  private scene: any;
  public primitives!: ReturnType<typeof this.createPrimitives>;
  private colorTable: Texture;
  textures: ReturnType<typeof this.createRenderingTextures>;
  framebuffers: ReturnType<typeof this.createRenderingFramebuffers>;

  constructor(context: any, options: WindLayerOptions, viewerParameters: any, computing: WindParticlesComputing, scene: any) {
    this.context = context;
    this.options = options;
    this.viewerParameters = viewerParameters;
    this.computing = computing;
    this.scene = scene;

    if (typeof this.options.particlesTextureSize !== 'number' || this.options.particlesTextureSize <= 0) {
      console.error('Invalid particlesTextureSize. Using default value of 256.');
      this.options.particlesTextureSize = 256;
    }

    this.colorTable = this.createColorTableTexture();
    this.textures = this.createRenderingTextures();
    this.framebuffers = this.createRenderingFramebuffers();
    this.primitives = this.createPrimitives();
  }

  createRenderingTextures() {
    const colorTextureOptions = {
      context: this.context,
      width: this.context.drawingBufferWidth,
      height: this.context.drawingBufferHeight,
      pixelFormat: PixelFormat.RGBA,
      pixelDatatype: PixelDatatype.UNSIGNED_BYTE
    };
    const depthTextureOptions = {
      context: this.context,
      width: this.context.drawingBufferWidth,
      height: this.context.drawingBufferHeight,
      pixelFormat: PixelFormat.DEPTH_COMPONENT,
      pixelDatatype: PixelDatatype.UNSIGNED_INT
    };

    return {
      segmentsColor: new Texture(colorTextureOptions),
      segmentsDepth: new Texture(depthTextureOptions)
    }
  }

  createRenderingFramebuffers() {
    return {
      segments: new Framebuffer({
        context: this.context,
        colorTextures: [this.textures.segmentsColor],
        depthTexture: this.textures.segmentsDepth
      })
    }
  }

  destoryRenderingFramebuffers() {
    Object.values(this.framebuffers).forEach((framebuffer: any) => {
      framebuffer.destroy();
    });
  }

  private createColorTableTexture(): Texture {
    const colorTableData = new Float32Array(this.options.colors.flatMap(color => {
      const cesiumColor = Color.fromCssColorString(color);
      return [cesiumColor.red, cesiumColor.green, cesiumColor.blue, cesiumColor.alpha];
    }));

    return new Texture({
      context: this.context,
      width: this.options.colors.length,
      height: 1,
      pixelFormat: PixelFormat.RGBA,
      pixelDatatype: PixelDatatype.FLOAT,
      sampler: new Sampler({
        minificationFilter: TextureMinificationFilter.LINEAR,
        magnificationFilter: TextureMagnificationFilter.LINEAR,
        wrapS: TextureWrap.CLAMP_TO_EDGE,
        wrapT: TextureWrap.CLAMP_TO_EDGE
      }),
      source: {
        width: this.options.colors.length,
        height: 1,
        arrayBufferView: colorTableData
      }
    });
  }

  createSegmentsGeometry(): Geometry {
    const repeatVertex = 4, texureSize = this.options.particlesTextureSize;
    // 坐标系
    //  z
    //  | /y
    //  |/
    //  o------x
    let st: any = []; // 纹理数组 st坐标系，左下角被定义为(0,0), 右上角为(1,1)，用于传入到顶点着色器中指代粒子的位置
    for (let s = 0; s < texureSize; s++) {
      for (let t = 0; t < texureSize; t++) {
        for (let i = 0; i < repeatVertex; i++) {
          st.push(s / texureSize);
          st.push(t / texureSize);
        }
      }
    }
    st = new Float32Array(st);

    const particlesCount = this.options.particlesTextureSize ** 2;

    let normal: any = [];
    for (let i = 0; i < particlesCount; i++) {
      normal.push(
        // (point to use, offset sign, not used component)
        -1, -1, 0,
        -1, 1, 0,
        1, -1, 0,
        1, 1, 0
      )
    }
    normal = new Float32Array(normal);

    let vertexIndexes: any = []; // 索引,一个粒子矩形由两个三角形组成
    for (let i = 0, vertex = 0; i < particlesCount; i++) {
      vertexIndexes.push(
        // 第一个三角形用的顶点
        vertex + 0, vertex + 1, vertex + 2,
        // 第二个三角形用的顶点
        vertex + 2, vertex + 1, vertex + 3
      )

      vertex += repeatVertex;
    }
    vertexIndexes = new Uint32Array(vertexIndexes);

    const geometry = new Geometry({
      attributes: new (GeometryAttributes as any)({
        st: new GeometryAttribute({
          componentDatatype: ComponentDatatype.FLOAT,
          componentsPerAttribute: 2,
          values: st
        }),
        normal: new GeometryAttribute({
          componentDatatype: ComponentDatatype.FLOAT,
          componentsPerAttribute: 3,
          values: normal
        }),
      }),
      indices: vertexIndexes
    });

    return geometry;
  }

  private createRawRenderState(options: {
    viewport?: any;
    depthTest?: any;
    depthMask?: any;
    blending?: any;
  }): any {
    return (Appearance as any).getDefaultRenderState(true, false, {
      viewport: undefined,
      depthTest: undefined,
      depthMask: undefined,
      blending: undefined,
      ...options
    });
  }

  private createPrimitives() {
    const segments = new CustomPrimitive({
      commandType: 'Draw',
      attributeLocations: {
        st: 0,
        normal: 1
      },
      geometry: this.createSegmentsGeometry(),
      primitiveType: PrimitiveType.TRIANGLES,
      uniformMap: {
        previousParticlesPosition: () => this.computing.particlesTextures.previousParticlesPosition,
        currentParticlesPosition: () => this.computing.particlesTextures.currentParticlesPosition,
        postProcessingPosition: () => this.computing.particlesTextures.postProcessingPosition,
        particlesSpeed: () => this.computing.particlesTextures.particlesSpeed,
        colorTable: () => this.colorTable,
        domain: () => {
          const domain = new Cartesian2(this.options.domain?.min ?? this.computing.windData.speed.min, this.options.domain?.max ?? this.computing.windData.speed.max);
          return domain;
        },
        displayRange: () => {
          const displayRange = new Cartesian2(
            this.options.displayRange?.min ?? this.computing.windData.speed.min,
            this.options.displayRange?.max ?? this.computing.windData.speed.max
          );
          return displayRange;
        },
        lineWidth: () => {
          const width = this.options.lineWidth || DefaultOptions.lineWidth;
          return new Cartesian2(width.min, width.max);
        },
        lineLength: () => {
          const length = this.options.lineLength || DefaultOptions.lineLength;
          return new Cartesian2(length.min, length.max);
        },
        viewport: () => new Cartesian2(
          this.scene.canvas.clientWidth,
          this.scene.canvas.clientHeight,
        ),
        windBounds: () => new Cartesian4(
          this.computing.windData.bounds.west,
          this.computing.windData.bounds.south,
          this.computing.windData.bounds.east,
          this.computing.windData.bounds.north,
        ),
        windCornerSW: () => this.projectWindCorner(
          this.computing.windData.bounds.west,
          this.computing.windData.bounds.south,
        ),
        windCornerSE: () => this.projectWindCorner(
          this.computing.windData.bounds.east,
          this.computing.windData.bounds.south,
        ),
        windCornerNW: () => this.projectWindCorner(
          this.computing.windData.bounds.west,
          this.computing.windData.bounds.north,
        ),
        windCornerNE: () => this.projectWindCorner(
          this.computing.windData.bounds.east,
          this.computing.windData.bounds.north,
        ),
      },
      modelMatrix: this.options.modelMatrix,
      vertexShaderSource: ShaderManager.getSegmentDrawVertexShader(),
      fragmentShaderSource: ShaderManager.getSegmentDrawFragmentShader(),
      rawRenderState: this.createRawRenderState({
        viewport: undefined,
        depthTest: {
          enabled: false
        },
        depthMask: false,
        blending: {
          enabled: true,
          blendEquation: WebGLRenderingContext.FUNC_ADD,
          blendFuncSource: WebGLRenderingContext.SRC_ALPHA,
          blendFuncDestination: WebGLRenderingContext.ONE_MINUS_SRC_ALPHA
        }
      })
    });

    return { segments };
  }

  private projectWindCorner(longitude: number, latitude: number): Cartesian2 {
    const world = Cartesian3.fromDegrees(longitude, latitude, this.options.particleHeight);
    const windowPosition = SceneTransforms.worldToWindowCoordinates(this.scene, world);
    if (!windowPosition) return new Cartesian2(-2, -2);
    return new Cartesian2(
      windowPosition.x / Math.max(this.scene.canvas.clientWidth, 1) * 2 - 1,
      1 - windowPosition.y / Math.max(this.scene.canvas.clientHeight, 1) * 2,
    );
  }

  onParticlesTextureSizeChange() {
    const geometry = this.createSegmentsGeometry();
    this.primitives.segments.geometry = geometry;
    const vertexArray = VertexArray.fromGeometry({
      context: this.context,
      geometry: geometry,
      attributeLocations: this.primitives.segments.attributeLocations,
      bufferUsage: BufferUsage.STATIC_DRAW,
    });
    if (this.primitives.segments.commandToExecute) {
      this.primitives.segments.commandToExecute.vertexArray = vertexArray;
    }
  }

  onColorTableChange() {
    this.colorTable.destroy();
    this.colorTable = this.createColorTableTexture();
  }

  updateOptions(options: Partial<WindLayerOptions>) {
    const needUpdateColorTable = options.colors &&
      JSON.stringify(options.colors) !== JSON.stringify(this.options.colors);

    // Update options first
    this.options = deepMerge(options, this.options);

    // Then update color table if needed
    if (needUpdateColorTable) {
      this.onColorTableChange();
    }
  }

  destroy(): void {
    Object.values(this.framebuffers).forEach((framebuffer: any) => {
      if (!framebuffer.isDestroyed?.()) framebuffer.destroy();
    });
    Object.values(this.primitives).forEach((primitive: any) => {
      primitive.destroy();
    });
    // Framebuffer owns and destroys segmentsColor/segmentsDepth attachments.
    this.colorTable.destroy();
  }
}
