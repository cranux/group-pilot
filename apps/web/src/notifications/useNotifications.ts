import { useSyncExternalStore } from 'react';
import { notifications, type NotificationSnapshot } from './store';

export function useNotifications(): NotificationSnapshot {
  return useSyncExternalStore(notifications.subscribe, notifications.getSnapshot, notifications.getSnapshot);
}
