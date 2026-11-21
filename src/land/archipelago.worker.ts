import { buffers, generate, type Job } from './archipelago-data';
self.onmessage = ({data}: MessageEvent<Job>) => {
  try {
    const packet = generate(data);
    self.postMessage({packet}, {transfer: buffers(packet)});
  } catch (e) {
    self.postMessage({error: String(e)});
  }
};
