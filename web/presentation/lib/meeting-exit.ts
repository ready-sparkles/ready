import { type LocalTrack, type LocalTrackPublication, type Room, RoomEvent } from "livekit-client";

import { getMeetingCaptureTrack } from "./meeting-media-track";

export const MEETING_DISCONNECT_TIMEOUT_MS = 2000;
const closingRooms = new WeakMap<Room, Promise<void>>();

async function beginDisconnectAndStopRoomMedia(room: Room): Promise<void> {
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, MEETING_DISCONNECT_TIMEOUT_MS);
    const attempt = (operation: () => void): void => {
      try {
        operation();
      } catch (stopError) {
        void stopError;
        /* Continue stopping other media. */
      }
    };
    const stopProcessor = async (track: LocalTrack): Promise<void> => {
      try {
        const processor = track.getProcessor();
        if (processor) {
          try {
            await processor.destroy();
          } catch (destroyError) {
            void destroyError;
          }
        }
      } catch (processorError) {
        void processorError;
      }
    };
    const stopLocalTrack = (track: LocalTrack): void => {
      attempt(() => {
        void stopProcessor(track);
      });
      attempt(() => getMeetingCaptureTrack(track).stop());
      attempt(() => track.mediaStreamTrack.stop());
      attempt(() => track.detach());
      attempt(() => track.stop());
    };
    attempt(() => {
      room.on(RoomEvent.LocalTrackPublished, (publication: LocalTrackPublication) => {
        if (publication.track) {
          stopLocalTrack(publication.track);
        }
      });
    });
    Array.from(room.localParticipant.trackPublications.values()).forEach((publication) => {
      if (publication.track) {
        stopLocalTrack(publication.track);
      }
    });
    room.remoteParticipants.forEach((participant) => {
      participant.trackPublications.forEach((publication) => {
        attempt(() => {
          publication.track?.detach();
        });
      });
    });
    const finalizeDisconnect = async (): Promise<void> => {
      try {
        await room.disconnect(true);
      } catch (disconnectError) {
        void disconnectError;
      } finally {
        clearTimeout(timer);
        resolve();
      }
    };
    void finalizeDisconnect();
  });
}

/** Cut media synchronously. SDK/network cleanup must not hold departure hostage. */
export async function disconnectAndStopRoomMedia(room: Room | null): Promise<void> {
  if (!room) {
    return;
  }
  const existing = closingRooms.get(room);
  if (existing) {
    await existing;

    return;
  }
  const pending = beginDisconnectAndStopRoomMedia(room);
  closingRooms.set(room, pending);
  await pending;
}
