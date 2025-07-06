// hooks/useSupabaseChannels.js
import { useCallback, useRef } from 'react';
import { supabase } from '../supabaseClient';

const useSupabaseChannels = () => {
  const channels = useRef({});

  const subscribe = useCallback((name, config) => {
    // Clean up existing channel if present
    if (channels.current[name]) {
      supabase.removeChannel(channels.current[name]);
    }

    const channel = supabase.channel(config.channelName, {
      config: {
        presence: { key: config.presenceKey },
        broadcast: { ack: true },
      },
    });

    if (config.onEvent) {
      channel.on('postgres_changes', config.options, config.onEvent);
    }

    const subscription = channel.subscribe((status, err) => {
      if (err) {
        console.error(`${name} channel error:`, err);
        setTimeout(() => subscribe(name, {
          ...config,
          retryCount: (config.retryCount || 0) + 1
        }), Math.min(1000 * Math.pow(2, config.retryCount || 1), 30000));
      }
    });

    channels.current[name] = channel;
    return channel;
  }, []);

  const unsubscribe = useCallback((name) => {
    if (channels.current[name]) {
      supabase.removeChannel(channels.current[name]);
      delete channels.current[name];
    }
  }, []);

  const unsubscribeAll = useCallback(() => {
    Object.keys(channels.current).forEach(unsubscribe);
  }, [unsubscribe]);

  return { subscribe, unsubscribe, unsubscribeAll };
};

export default useSupabaseChannels;