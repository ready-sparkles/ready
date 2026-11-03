"use client";

import { type LocalVideoTrack, TrackEvent } from "livekit-client";
import { type ReactNode, useEffect, useRef, useState } from "react";

const REQUIRED_PAINTED_PREVIEW_FRAMES = 2;

function ProcessedPreviewVideo({
  track,
  className,
  placeholder,
}: {
  track: MediaStreamTrack;
  className: string;
  placeholder?: ReactNode;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const isCancelledRef = useRef(false);
  const frameCallbackRef = useRef<number | undefined>(undefined);
  const frameCountRef = useRef(0);
  const [isReady, setIsReady] = useState(false);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) {
      return;
    }
    isCancelledRef.current = false;
    frameCallbackRef.current = undefined;
    frameCountRef.current = 0;
    const reveal = () => {
      if (!isCancelledRef.current) {
        setIsReady(true);
      }
    };
    if (typeof video.requestVideoFrameCallback === "function") {
      const onFrame = () => {
        if (isCancelledRef.current) {
          return;
        }
        // Canvas capture can begin with an empty frame. Wait for the next
        // painted frame while the avatar remains visible.
        frameCountRef.current += 1;
        if (frameCountRef.current >= REQUIRED_PAINTED_PREVIEW_FRAMES) {
          reveal();
        } else {
          frameCallbackRef.current = video.requestVideoFrameCallback(onFrame);
        }
      };
      frameCallbackRef.current = video.requestVideoFrameCallback(onFrame);
    } else {
      video.addEventListener("loadeddata", reveal);
    }
    video.srcObject = new MediaStream([track]);
    void (async () => {
      try {
        await video.play();
      } catch (error) {
        void error;
        // Keep raw camera output hidden if processed playback fails.
      }
    })();

    return () => {
      isCancelledRef.current = true;
      if (frameCallbackRef.current !== undefined) {
        video.cancelVideoFrameCallback(frameCallbackRef.current);
      }
      video.removeEventListener("loadeddata", reveal);
      video.srcObject = null;
    };
  }, [track]);

  return (
    <>
      {!isReady ? placeholder : null}
      <video
        ref={videoRef}
        className={className}
        autoPlay
        playsInline
        muted
        data-preview-source="processed"
        style={{ opacity: isReady ? 1 : 0 }}
      />
    </>
  );
}

export function MeetingPreviewVideo({
  stream,
  track,
  showProcessed: isShowingProcessed,
  className,
  placeholder,
}: {
  stream: MediaStream;
  track: LocalVideoTrack | null;
  /** @external existing wire contract */
  showProcessed: boolean;
  className: string;
  placeholder?: ReactNode;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [output, setOutput] = useState<{ owner: LocalVideoTrack; track: MediaStreamTrack } | null>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) {
      return;
    }
    // Do not register this element with LocalVideoTrack.attach(): the SDK
    // swaps attached elements to processed output before its first frame.
    video.srcObject = stream;
    void (async () => {
      try {
        await video.play();
      } catch (error) {
        void error;
        // Ignore autoplay failures for preview playback.
      }
    })();

    return () => {
      video.srcObject = null;
    };
  }, [stream]);

  useEffect(() => {
    const update = () => {
      const processed = track?.getProcessor()?.processedTrack;
      setOutput(track && processed ? { owner: track, track: processed } : null);
    };
    update();
    track?.on(TrackEvent.TrackProcessorUpdate, update);

    return () => {
      track?.off(TrackEvent.TrackProcessorUpdate, update);
    };
  }, [track]);

  return (
    <>
      <video
        ref={videoRef}
        className={className}
        autoPlay
        playsInline
        muted
        data-preview-source="camera"
        style={{ visibility: isShowingProcessed ? "hidden" : "visible" }}
      />
      {isShowingProcessed && output !== null && output.owner === track ? (
        <ProcessedPreviewVideo
          key={output.track.id}
          track={output.track}
          className={className}
          placeholder={placeholder}
        />
      ) : isShowingProcessed ? (
        placeholder
      ) : null}
    </>
  );
}
