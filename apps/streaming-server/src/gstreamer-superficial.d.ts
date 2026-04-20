declare module "gstreamer-superficial" {
  interface GstBuffer {
    // GStreamer buffer type
  }

  interface GstBufferConstructor {
    fromData(data: NodeJS.ArrayBufferView): GstBuffer;
  }

  interface Pipeline {
    new(pipeline: string): Pipeline;
    findChild(name: string): any | null;
    setPlaying(playing: boolean): void;
    sendEos(): void;
    on(event: string, callback: Function): void;
  }

  interface AppSrc {
    set(property: string, value: any): void;
    emit(event: string, ...args: any[]): void;
    pushBuffer(buffer: any): void;
  }

  const Gst: {
    Pipeline: Pipeline;
    Buffer: GstBufferConstructor;
  };

  export default Gst;
}