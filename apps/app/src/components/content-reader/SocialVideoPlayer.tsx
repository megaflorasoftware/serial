"use client";

import clsx from "clsx";
import {
  FullscreenIcon,
  Loader2Icon,
  PlayIcon,
  Volume2Icon,
  VolumeXIcon,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import type { ReaderSocialVideo } from "@serial/standard-site";
import { ButtonWithShortcut } from "~/components/ButtonWithShortcut";
import { YOUTUBE_PLAYBACK_SPEEDS } from "~/components/CustomVideoPlayer/constants";
import { Slider } from "~/components/ui/slider";
import { ToggleGroup, ToggleGroupItem } from "~/components/ui/toggle-group";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "~/components/ui/tooltip";
import { useFlagState } from "~/lib/hooks/useFlagState";
import { REMOTE_IMAGE_PROPS } from "~/lib/remoteMedia";
import { transformSecondsToFormattedTime } from "~/lib/transformSecondsToFormattedTime";

type HlsInstance = { destroy: () => void };

/**
 * Attaches an HLS stream to a video element: natively where the browser
 * plays HLS itself (Safari), otherwise through hls.js, which loads only on
 * first play so readers who never press play never pay for it.
 */
async function attachStream(
  video: HTMLVideoElement,
  playlistUrl: string,
): Promise<HlsInstance | null> {
  if (video.canPlayType("application/vnd.apple.mpegurl")) {
    video.src = playlistUrl;
    return null;
  }
  const { default: Hls } = await import("hls.js/light");
  if (!Hls.isSupported()) {
    video.src = playlistUrl;
    return null;
  }
  const hls = new Hls({ enableWorker: true });
  hls.loadSource(playlistUrl);
  hls.attachMedia(video);
  return hls;
}

/** Calls back as the element crosses half-visible, without re-rendering the player. */
function useInView(
  ref: React.RefObject<HTMLElement | null>,
  onChange: (inView: boolean) => void,
  enabled: boolean,
) {
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);
  useEffect(() => {
    const element = ref.current;
    if (!enabled || !element || typeof IntersectionObserver === "undefined")
      return;
    const observer = new IntersectionObserver(
      (entries) =>
        onChangeRef.current(entries.some((entry) => entry.isIntersecting)),
      { threshold: 0.5 },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [enabled, ref]);
}

/**
 * A Bluesky video inside a social card, drawn with the custom player's
 * chrome: poster and play button until first play, then the speed rail,
 * mute, fullscreen, timestamps and scrubber over the stream. A gif-style
 * video instead loops silently while it is on screen, like Bluesky.
 */
export function SocialVideoPlayer({
  video,
  platform,
  style,
}: {
  video: ReaderSocialVideo;
  platform: string;
  style?: CSSProperties;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<HlsInstance | null>(null);
  const [started, setStarted] = useState(false);
  const [loading, setLoading] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(video.gif);
  const [speed, setSpeed] = useState(1);
  const [duration, setDuration] = useState(0);
  const [progress, setProgress] = useState(0);
  const [failed, setFailed] = useState(false);
  const [hasInlineShortcutsVisible] = useFlagState("INLINE_SHORTCUTS");
  const startedRef = useRef(false);

  const start = useCallback(async () => {
    const element = videoRef.current;
    if (!element || startedRef.current) return;
    startedRef.current = true;
    setStarted(true);
    setLoading(true);
    try {
      hlsRef.current = await attachStream(element, video.playlistUrl);
      await element.play();
    } catch {
      setFailed(true);
      setLoading(false);
    }
  }, [video.playlistUrl]);

  // A gif plays itself while on screen and pauses off screen.
  useInView(
    containerRef,
    (inView) => {
      const element = videoRef.current;
      if (!element) return;
      if (inView) {
        if (!startedRef.current) void start();
        else void element.play().catch(() => {});
      } else if (startedRef.current) {
        element.pause();
      }
    },
    video.gif,
  );

  useEffect(() => {
    return () => {
      hlsRef.current?.destroy();
      hlsRef.current = null;
    };
  }, []);

  const toggle = () => {
    const element = videoRef.current;
    if (!element) return;
    if (!started) {
      void start();
      return;
    }
    if (element.paused) void element.play().catch(() => {});
    else element.pause();
  };

  const toggleMute = () => {
    const element = videoRef.current;
    if (!element) return;
    element.muted = !element.muted;
    setMuted(element.muted);
  };

  const changeSpeed = (value: number) => {
    setSpeed(value);
    if (videoRef.current) videoRef.current.playbackRate = value;
  };

  const seek = (seconds: number) => {
    const element = videoRef.current;
    if (!element) return;
    element.currentTime = seconds;
    setProgress(seconds);
  };

  const toggleFullscreen = () => {
    const element = containerRef.current;
    if (!element) return;
    if (document.fullscreenElement) void document.exitFullscreen();
    else void element.requestFullscreen?.();
  };

  const showPoster = !started || (!playing && !loading && progress === 0);
  const label = failed
    ? `Video from the post on ${platform} could not be played`
    : loading
      ? "Video loading"
      : playing
        ? "Pause video"
        : "Play video";

  return (
    <div
      ref={containerRef}
      data-social-post-video-player={video.gif ? "gif" : "video"}
      data-social-post-video-state={
        failed ? "failed" : playing ? "playing" : started ? "paused" : "poster"
      }
      className="group relative w-full overflow-hidden rounded bg-black"
      style={style}
    >
      <video
        ref={videoRef}
        className="h-full w-full object-contain"
        playsInline
        loop={video.gif}
        muted={muted}
        preload="none"
        aria-label={video.alt || `Video from the post on ${platform}`}
        onPlaying={() => {
          setPlaying(true);
          setLoading(false);
        }}
        onWaiting={() => setLoading(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
        onDurationChange={(event) =>
          setDuration(event.currentTarget.duration || 0)
        }
        onTimeUpdate={(event) => setProgress(event.currentTarget.currentTime)}
        onError={() => {
          setFailed(true);
          setLoading(false);
        }}
      >
        {/* The first, sourceless track satisfies the caption rule the way the
            app's other players do; the record's own captions follow it. */}
        <track kind="captions" />
        {video.captions.map((caption) => (
          <track
            key={caption.url}
            kind="captions"
            srcLang={caption.lang}
            src={caption.url}
          />
        ))}
      </video>
      <div
        className={clsx("absolute inset-0 transition-opacity", {
          "pointer-events-none opacity-0": !showPoster,
        })}
      >
        <img
          {...REMOTE_IMAGE_PROPS}
          className="h-full w-full object-contain"
          alt=""
          src={video.thumbnailUrl}
        />
      </div>
      {!video.gif && (
        <button
          type="button"
          data-social-post-video-toggle
          aria-label={label}
          aria-disabled={failed}
          onClick={toggle}
          className={clsx(
            "absolute inset-0 z-20 grid place-items-center",
            failed ? "cursor-default" : "cursor-pointer",
          )}
        >
          <span
            className={clsx(
              "bg-background grid size-16 place-items-center rounded-2xl shadow-2xl transition-all group-hover:scale-105",
              { "opacity-0": playing && !loading },
            )}
          >
            {loading ? (
              <Loader2Icon
                aria-hidden="true"
                className="animate-spin"
                size={28}
              />
            ) : (
              <PlayIcon aria-hidden="true" size={28} />
            )}
          </span>
        </button>
      )}
      {failed && (
        <p
          data-social-post-video-error
          className="absolute inset-x-0 bottom-0 z-30 bg-black/60 p-2 text-center text-xs text-white"
        >
          This video could not be played.
        </p>
      )}
      {started && !failed && !video.gif && (
        <>
          <div className="dark absolute inset-y-0 right-0 z-30 flex flex-col items-end justify-center bg-gradient-to-l from-black/50 from-70% to-transparent p-3 pl-8 text-white opacity-0 transition-opacity group-hover:opacity-100">
            <ToggleGroup
              type="single"
              value={speed.toString()}
              onValueChange={(value) => {
                if (value) changeSpeed(parseFloat(value));
              }}
              size="xs"
              className="flex flex-col items-center justify-center font-mono"
            >
              {YOUTUBE_PLAYBACK_SPEEDS.map((entry) => (
                <ToggleGroupItem
                  key={entry.value}
                  value={entry.value.toString()}
                >
                  {entry.label}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </div>
          <div className="dark absolute inset-x-0 bottom-0 z-30 flex flex-col justify-end bg-gradient-to-t from-black/50 from-70% to-transparent p-3 pt-8 text-white opacity-0 transition-opacity group-hover:opacity-100">
            <div className="flex items-center justify-between">
              <div className="w-max font-mono text-sm font-bold">
                {transformSecondsToFormattedTime(progress)} /{" "}
                {transformSecondsToFormattedTime(duration)}
              </div>
              <div className="flex items-center gap-2">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <ButtonWithShortcut
                      shortcut="m"
                      size="icon"
                      variant={
                        hasInlineShortcutsVisible === "show-shortcuts"
                          ? "outline"
                          : "ghost"
                      }
                      onClick={toggleMute}
                    >
                      {muted ? (
                        <VolumeXIcon size={16} />
                      ) : (
                        <Volume2Icon size={16} />
                      )}
                    </ButtonWithShortcut>
                  </TooltipTrigger>
                  <TooltipContent>Toggle mute</TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <ButtonWithShortcut
                      shortcut="f"
                      size="icon"
                      variant={
                        hasInlineShortcutsVisible === "show-shortcuts"
                          ? "outline"
                          : "ghost"
                      }
                      onClick={toggleFullscreen}
                    >
                      <FullscreenIcon size={16} />
                    </ButtonWithShortcut>
                  </TooltipTrigger>
                  <TooltipContent>Toggle fullscreen</TooltipContent>
                </Tooltip>
              </div>
            </div>
            <Slider
              value={[progress]}
              min={0}
              max={duration || 1}
              step={0.1}
              onValueChange={(value) => seek(value[0]!)}
              className="mt-2 mr-4"
            />
          </div>
        </>
      )}
    </div>
  );
}
