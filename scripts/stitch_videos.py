
"""用 PyAV 拼接 ComfyUI 生成的 mp4 片段（按帧精确裁剪、末帧定格、音画同步）。

用法： python stitch_videos.py <spec.json>
spec.json = {
  "fps": 24,
  "output": "out.mp4",
  "segments": [{"file": "a.mp4", "frames": 124}, {"file": "b.mp4", "frames": 124}],
  "hold_last_frames": 5,          # 末尾定格帧数（可选）
  "audio_rate": 32000
}
"""
import av
import json
import sys

def decode_segment(path, max_frames=None, audio_rate=32000):
    container = av.open(path)
    vstream = container.streams.video[0]
    astream = container.streams.audio[0] if container.streams.audio else None
    frames = []
    for frame in container.decode(vstream):
        arr = frame.to_ndarray(format="rgb24")
        frames.append(arr)
        if max_frames is not None and len(frames) >= max_frames:
            break
    samples = None
    if astream is not None:
        resampler = av.AudioResampler(format="fltp", layout="stereo", rate=audio_rate)
        chunks = []
        for frame in container.decode(astream):
            for rf in resampler.resample(frame):
                chunks.append(rf.to_ndarray())
        try:
            for rf in resampler.resample(None):
                chunks.append(rf.to_ndarray())
        except Exception:
            pass
        if chunks:
            samples = __import__("numpy").concatenate(chunks, axis=1)
    container.close()
    return frames, samples

def main():
    spec = json.load(open(sys.argv[1], encoding="utf-8"))
    fps = float(spec.get("fps", 24))
    audio_rate = int(spec.get("audio_rate", 32000))
    hold = int(spec.get("hold_last_frames", 0))
    out_path = spec["output"]

    all_video = []
    all_audio = []
    import numpy as np
    for seg in spec["segments"]:
        frames, samples = decode_segment(seg["file"], seg.get("frames"), audio_rate)
        n = len(frames)
        if seg.get("frames") is not None:
            n_keep = min(n, int(seg["frames"]))
            frames = frames[:n_keep]
            n = n_keep
        else:
            n = len(frames)
        all_video.extend(frames)
        want = int(round(n * audio_rate / fps))
        if samples is not None:
            if samples.shape[1] >= want:
                all_audio.append(samples[:, :want])
            else:
                pad = np.zeros((samples.shape[0], want - samples.shape[1]), dtype=samples.dtype)
                all_audio.append(np.concatenate([samples, pad], axis=1))
        else:
            all_audio.append(np.zeros((2, want), dtype=np.float32))

    if hold > 0:
        for _ in range(hold):
            all_video.append(all_video[-1])
        want_hold = int(round(hold * audio_rate / fps))
        last = all_audio[-1]
        pad = np.zeros((last.shape[0], want_hold), dtype=np.float32)
        all_audio.append(pad)

    audio = np.concatenate(all_audio, axis=1) if all_audio else None
    total_frames = len(all_video)

    container = av.open(out_path, mode="w")
    vstream = container.add_stream("libx264", rate=int(fps))
    vstream.width = all_video[0].shape[1]
    vstream.height = all_video[0].shape[0]
    vstream.pix_fmt = "yuv420p"
    try:
        vstream.options = {"crf": "18", "preset": "medium"}
    except Exception:
        pass
    astream = None
    if audio is not None and audio.shape[1] > 0:
        astream = container.add_stream("aac", rate=audio_rate)
        astream.layout = "stereo"

    for i, arr in enumerate(all_video):
        frame = av.VideoFrame.from_ndarray(arr, format="rgb24")
        frame.pts = i
        for packet in vstream.encode(frame):
            container.mux(packet)

    if astream is not None:
        step = 1024
        for start in range(0, audio.shape[1], step):
            chunk = audio[:, start:start + step]
            if chunk.shape[1] == 0:
                break
            if chunk.shape[1] < step:
                pad = np.zeros((chunk.shape[0], step - chunk.shape[1]), dtype=chunk.dtype)
                chunk = np.concatenate([chunk, pad], axis=1)
            chunk = chunk.astype("float32")
            aframe = av.AudioFrame.from_ndarray(chunk, format="fltp", layout="stereo")
            aframe.sample_rate = audio_rate
            aframe.pts = start
            for packet in astream.encode(aframe):
                container.mux(packet)

    for packet in vstream.encode():
        container.mux(packet)
    if astream is not None:
        for packet in astream.encode():
            container.mux(packet)
    container.close()
    print(json.dumps({
        "output": out_path,
        "frames": total_frames,
        "duration": round(total_frames / fps, 3),
        "audio_samples": int(audio.shape[1]) if audio is not None else 0,
        "width": int(all_video[0].shape[1]),
        "height": int(all_video[0].shape[0]),
    }, ensure_ascii=False))

if __name__ == "__main__":
    main()
