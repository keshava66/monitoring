import React, { createContext, useContext, useEffect, useState } from 'react';
import { useAuth } from './AuthContext';
import { apiFetch } from '../utils/apiClient';

const ProfilePhotoContext = createContext({ profilePhoto: null, photoLoading: false });

/** Fetches the signed-in user's photo once and shares it app-wide. */
export function ProfilePhotoProvider({ children }) {
  const { user } = useAuth();
  const [state, setState] = useState({ profilePhoto: null, photoLoading: true });

  useEffect(() => {
    if (!user) return undefined;
    let url = null;
    const controller = new AbortController();
    apiFetch('/auth/user/photo', { signal: controller.signal, timeoutMs: 15_000 })
      .then(async (res) => {
        if (!res.ok) return null;
        url = URL.createObjectURL(await res.blob());
        return url;
      })
      .catch(() => null)
      .then((photo) => { if (!controller.signal.aborted) setState({ profilePhoto: photo, photoLoading: false }); });
    return () => {
      controller.abort();
      if (url) URL.revokeObjectURL(url);
    };
  }, [user]);

  return <ProfilePhotoContext.Provider value={state}>{children}</ProfilePhotoContext.Provider>;
}

export const useProfilePhoto = () => useContext(ProfilePhotoContext);
