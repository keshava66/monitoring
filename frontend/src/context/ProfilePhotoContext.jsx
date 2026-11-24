import React, { createContext, useContext } from 'react';
import { useAuth } from './AuthContext';
import { useProfilePhoto as _useProfilePhotoHook } from '../hooks/useProfilePhoto';

const ProfilePhotoContext = createContext(null);

export function ProfilePhotoProvider({ children }) {
  const { user, logout } = useAuth();
  const { profilePhoto, photoLoading } = _useProfilePhotoHook(user, logout);

  return (
    <ProfilePhotoContext.Provider value={{ profilePhoto, photoLoading }}>
      {children}
    </ProfilePhotoContext.Provider>
  );
}

/**
 * Drop-in replacement for the old useProfilePhoto(user, logout) hook.
 * No arguments needed — photo is already fetched by the provider.
 */
export function useProfilePhoto() {
  const ctx = useContext(ProfilePhotoContext);
  if (!ctx) throw new Error('useProfilePhoto must be used within a ProfilePhotoProvider');
  return ctx;
}