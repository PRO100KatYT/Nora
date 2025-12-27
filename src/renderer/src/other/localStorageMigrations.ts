import type { MigrationData } from '../utils/localStorage';
import { LOCAL_STORAGE_DEFAULT_TEMPLATE } from './appReducer';

const localStorageMigrationData: MigrationData = {
  '2.4.2-stable': (storage) => {
    storage.equalizerPreset = LOCAL_STORAGE_DEFAULT_TEMPLATE.equalizerPreset;
    return storage;
  },
  '4.0.0-alpha.3': (storage) => {
    // Migrate songId from string to number in queue
    if (storage.queue && storage.queue.songIds) {
      storage.queue.songIds = storage.queue.songIds.map((id) =>
        typeof id === 'string' ? Number(id) : id
      ) as number[];
    }

    // Migrate currentSongId from string to number in playback
    if (storage.playback?.currentSong?.songId && typeof storage.playback.currentSong.songId === 'string') {
      storage.playback.currentSong.songId = Number(storage.playback.currentSong.songId);
    }

    return storage;
  }
};

export default localStorageMigrationData;
