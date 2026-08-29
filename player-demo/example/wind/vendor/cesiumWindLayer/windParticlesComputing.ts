import { PixelDatatype, PixelFormat, Sampler, Texture, TextureMagnificationFilter, TextureMinificationFilter, Cartesian2, FrameRateMonitor } from 'cesium';
import { WindLayerOptions, WindData } from './types';
import { ShaderManager } from './shaderManager';
import CustomPrimitive from './customPrimitive'
import { deepMerge } from './utils';

export class WindParticlesComputing {
  context: any;
  options: WindLayerOptions;
  viewerParameters: any;
  windTextures!: {
    U: Texture;
    V: Texture;
  };
  particlesTextures!: {
    previousParticlesPosition: Texture;
    currentParticlesPosition: Texture;
    nextParticlesPosition: Texture;
    postProcessingPosition: Texture;
    particlesSpeed: Texture;
  };
  primitives!: {
    calculateSpeed: CustomPrimitive;
    updatePosition: CustomPrimitive;
    postProcessingPosition: CustomPrimitive;
  };
  windData: Required<WindData>;
  private frameRateMonitor: FrameRateMonitor;
  private frameRateInterval?: ReturnType<typeof setInterval>;
  frameRate: number = 60;
  frameRateAdjustment: number = 1;

  constructor(context: any, windData: Required<WindData>, options: WindLayerOptions, viewerParameters: any, scene: any) {
    this.context = context;
    this.options = options;
    this.viewerParameters = viewerParameters;
    this.windData = windData;

    this.frameRateMonitor = new FrameRateMonitor({
      scene: scene,
      samplingWindow: 1.0,
      quietPeriod: 0.0
    });
    this.initFrameRate();
    this.createWindTextures();
    this.createParticlesTextures();
    this.createComputingPrimitives();
  }

  private initFrameRate() {
    const updateFrameRate = () => {
      // avoid update frame rate when frame rate is too low
      if (this.frameRateMonitor.lastFramesPerSecond > 20) {
        this.frameRate = this.frameRateMonitor.lastFramesPerSecond;
        this.frameRateAdjustment = 60 / Math.max(this.frameRate, 1);
      }
    }

    // Initial frame rate calculation
    updateFrameRate();

    // Use setInterval instead of requestAnimationFrame
    this.frameRateInterval = setInterval(updateFrameRate, 1000);

  }

  createWindTextures() {
    const options = {
      context: this.context,
      width: this.windData.width,
      height: this.windData.height,
      pixelFormat: PixelFormat.RED,
      pixelDatatype: PixelDatatype.FLOAT,
      flipY: this.options.flipY ?? false,
      sampler: new Sampler({
        minificationFilter: TextureMinificationFilter.LINEAR,
        magnificationFilter: TextureMagnificationFilter.LINEAR
      })
    }

    this.windTextures = {
      U: new Texture({
        ...options,
        source: {
          arrayBufferView: new Float32Array(this.windData.u.array)
        }
      }),
      V: new Texture({
        ...options,
        source: {
          arrayBufferView: new Float32Array(this.windData.v.array)
        }
      }),
    };
  }

  createParticlesTextures() {
    const particlePositionData = createInitialParticlePositionData(
      this.options.particlesTextureSize,
      this.windData.bounds,
    );
    const positionOptions = {
      context: this.context,
      width: this.options.particlesTextureSize,
      height: this.options.particlesTextureSize,
      pixelFormat: PixelFormat.RGBA,
      pixelDatatype: PixelDatatype.FLOAT,
      flipY: false,
      source: {
        arrayBufferView: particlePositionData,
      },
      sampler: new Sampler({
        minificationFilter: TextureMinificationFilter.NEAREST,
        magnificationFilter: TextureMagnificationFilter.NEAREST
      })
    }

    const speedOptions = {
      ...positionOptions,
      source: {
        arrayBufferView: new Float32Array(
          this.options.particlesTextureSize * this.options.particlesTextureSize * 4,
        ).fill(0),
      },
    };
    this.particlesTextures = {
      previousParticlesPosition: new Texture(positionOptions),
      currentParticlesPosition: new Texture(positionOptions),
      nextParticlesPosition: new Texture(positionOptions),
      postProcessingPosition: new Texture(positionOptions),
      particlesSpeed: new Texture(speedOptions)
    };
  }

  destroyParticlesTextures() {
    Object.values(this.particlesTextures).forEach(texture => texture.destroy());
  }

  createComputingPrimitives() {
    this.primitives = {
      calculateSpeed: new CustomPrimitive({
        commandType: 'Compute',
        uniformMap: {
          U: () => this.windTextures.U,
          V: () => this.windTextures.V,
          uRange: () => new Cartesian2(this.windData.u.min, this.windData.u.max),
          vRange: () => new Cartesian2(this.windData.v.min, this.windData.v.max),
          speedRange: () => new Cartesian2(this.windData.speed.min, this.windData.speed.max),
          currentParticlesPosition: () => this.particlesTextures.currentParticlesPosition,
          speedScaleFactor: () => {
            return (this.viewerParameters.pixelSize + 50) * this.options.speedFactor;
          },
          frameRateAdjustment: () => this.frameRateAdjustment,
          dimension: () => new Cartesian2(this.windData.width, this.windData.height),
          minimum: () => new Cartesian2(this.windData.bounds.west, this.windData.bounds.south),
          maximum: () => new Cartesian2(this.windData.bounds.east, this.windData.bounds.north),
        },
        fragmentShaderSource: ShaderManager.getCalculateSpeedShader(),
        outputTexture: this.particlesTextures.particlesSpeed,
        preExecute: () => {
          const temp = this.particlesTextures.previousParticlesPosition;
          this.particlesTextures.previousParticlesPosition = this.particlesTextures.currentParticlesPosition;
          this.particlesTextures.currentParticlesPosition = this.particlesTextures.postProcessingPosition;
          this.particlesTextures.postProcessingPosition = temp;
          if (this.primitives.calculateSpeed.commandToExecute) {
            this.primitives.calculateSpeed.commandToExecute.outputTexture = this.particlesTextures.particlesSpeed;
          }
        },
        isDynamic: () =>this.options.dynamic
      }),

      updatePosition: new CustomPrimitive({
        commandType: 'Compute',
        uniformMap: {
          currentParticlesPosition: () => this.particlesTextures.currentParticlesPosition,
          particlesSpeed: () => this.particlesTextures.particlesSpeed,
        },
        fragmentShaderSource: ShaderManager.getUpdatePositionShader(),
        outputTexture: this.particlesTextures.nextParticlesPosition,
        preExecute: () => {
          if (this.primitives.updatePosition.commandToExecute) {
            this.primitives.updatePosition.commandToExecute.outputTexture = this.particlesTextures.nextParticlesPosition;
          }
        },
        isDynamic: () => this.options.dynamic
      }),

      postProcessingPosition: new CustomPrimitive({
        commandType: 'Compute',
        uniformMap: {
          nextParticlesPosition: () => this.particlesTextures.nextParticlesPosition,
          particlesSpeed: () => this.particlesTextures.particlesSpeed,
          lonRange: () => this.viewerParameters.lonRange,
          latRange: () => this.viewerParameters.latRange,
          dataLonRange: () => new Cartesian2(this.windData.bounds.west, this.windData.bounds.east),
          dataLatRange: () => new Cartesian2(this.windData.bounds.south, this.windData.bounds.north),
          randomCoefficient: function () {
            return Math.random();
          },
          dropRate: () => this.options.dropRate,
          dropRateBump: () => this.options.dropRateBump,
          useViewerBounds: () => this.options.useViewerBounds
        },
        fragmentShaderSource: ShaderManager.getPostProcessingPositionShader(),
        outputTexture: this.particlesTextures.postProcessingPosition,
        preExecute: () => {
          if (this.primitives.postProcessingPosition.commandToExecute) {
            this.primitives.postProcessingPosition.commandToExecute.outputTexture = this.particlesTextures.postProcessingPosition;
          }
        },
        isDynamic: () => this.options.dynamic
      })
    };
  }

  private reCreateWindTextures() {
    this.windTextures.U.destroy();
    this.windTextures.V.destroy();
    this.createWindTextures();
  }

  updateWindData(data: Required<WindData>) {
    this.windData = data;
    this.reCreateWindTextures();
  }

  updateOptions(options: Partial<WindLayerOptions>) {
    const needUpdateWindTextures = options.flipY !== undefined && options.flipY !== this.options.flipY;
    this.options = deepMerge(options, this.options);
    if (needUpdateWindTextures) {
      this.reCreateWindTextures();
    }
  }

  processWindData(data: {
    array: Float32Array;
    min?: number;
    max?: number;
  }): Float32Array {
    const { array } = data;
    let { min, max } = data;
    const result = new Float32Array(array.length);
    if (min === undefined) {
      min = Math.min(...array);
    }
    if (max === undefined) {
      max = Math.max(...array);
    }

    const maxNum = Math.max(Math.abs(min), Math.abs(max));

    for (let i = 0; i < array.length; i++) {
      const value = array[i] / maxNum; // Normalize to [-1, 1]
      result[i] = value;
    }
    return result;
  }

  destroy() {
    if (this.frameRateInterval !== undefined) {
      clearInterval(this.frameRateInterval);
      this.frameRateInterval = undefined;
    }
    Object.values(this.windTextures).forEach(texture => texture.destroy());
    Object.values(this.particlesTextures).forEach(texture => texture.destroy());
    Object.values(this.primitives).forEach(primitive => primitive.destroy());
    this.frameRateMonitor.destroy();
  }
}

function createInitialParticlePositionData(
  textureSize: number,
  bounds: Required<WindData>["bounds"],
): Float32Array {
  const data = new Float32Array(textureSize * textureSize * 4);
  for (let index = 0; index < textureSize * textureSize; index += 1) {
    const offset = index * 4;
    const x = halton(index + 1, 2);
    const y = halton(index + 1, 3);
    data[offset] = bounds.west + (bounds.east - bounds.west) * x;
    data[offset + 1] = bounds.south + (bounds.north - bounds.south) * y;
    data[offset + 2] = 0;
    data[offset + 3] = 0;
  }
  return data;
}

function halton(index: number, base: number): number {
  let value = 0;
  let fraction = 1 / base;
  let remainder = index;
  while (remainder > 0) {
    value += (remainder % base) * fraction;
    remainder = Math.floor(remainder / base);
    fraction /= base;
  }
  return value;
}
