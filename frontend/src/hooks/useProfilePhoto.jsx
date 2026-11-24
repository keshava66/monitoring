import { useState, useEffect, useRef } from 'react';
import { useMsal } from '@azure/msal-react';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL;

export const useProfilePhoto = (user, onSessionExpired) => {
  const { instance, accounts } = useMsal();
  const [profilePhoto, setProfilePhoto] = useState(null);
  const [photoLoading, setPhotoLoading] = useState(true);
  const hasFetchedRef  = useRef(false);
  const isFetchingRef  = useRef(false);

  useEffect(() => {
    // track the blob URL locally so cleanup always revokes the right URL
    let objectUrl = null;

    if (!user || accounts.length === 0 || hasFetchedRef.current || isFetchingRef.current) {
      if (!user || accounts.length === 0) {
        setPhotoLoading(false);
      }
      return;
    }

    const fetchProfilePhoto = async () => {
      isFetchingRef.current = true;

      try {
        const account = accounts[0];
        if (!account) {
          setPhotoLoading(false);
          return;
        }

        if (!account.username || !account.homeAccountId || !account.idTokenClaims) {
          setPhotoLoading(false);
          return;
        }

        const activeAccount = instance.getActiveAccount();
        if (!activeAccount || activeAccount.homeAccountId !== account.homeAccountId) {
          console.warn('Session expired - logging out user');
          if (onSessionExpired) onSessionExpired();
          setPhotoLoading(false);
          return;
        }

        let token;

        try {
          const response = await instance.acquireTokenSilent({
            scopes: ['User.Read'],
            account,
          });

          if (!response?.accessToken) {
            setPhotoLoading(false);
            return;
          }

          token = response.accessToken;
        } catch (silentError) {
          if (
            silentError.name === 'InteractionRequiredAuthError' ||
            silentError.errorCode === 'interaction_required' ||
            silentError.message?.includes('AADSTS')
          ) {
            console.log('Silent token acquisition failed, trying interactive login...');
            try {
              const interactiveResponse = await instance.acquireTokenPopup({
                scopes: ['User.Read'],
                account,
              });

              if (!interactiveResponse?.accessToken) {
                console.warn('Interactive token acquisition failed - session invalid');
                if (onSessionExpired) onSessionExpired();
                setPhotoLoading(false);
                return;
              }

              token = interactiveResponse.accessToken;
            } catch {
              console.warn('Session expired - user authentication required');
              if (onSessionExpired) onSessionExpired();
              setPhotoLoading(false);
              return;
            }
          } else {
            throw silentError;
          }
        }

        const photoResponse = await fetch(`${API_BASE_URL}/auth/user/photo`, {
          headers: { Authorization: `Bearer ${token}` },
        });

        if (photoResponse.ok) {
          const blob = await photoResponse.blob();
          // Fix 3: assign to local var AND state
          objectUrl = URL.createObjectURL(blob);
          setProfilePhoto(objectUrl);
        } else if (photoResponse.status === 401 || photoResponse.status === 403) {
          console.warn('Backend authentication failed - session may be expired');
          if (onSessionExpired) onSessionExpired();
          setProfilePhoto(null);
        } else {
          // No photo available — normal for many accounts
          setProfilePhoto(null);
        }
      } catch (error) {
        const isAuthError =
          error.name === 'InteractionRequiredAuthError' ||
          error.errorCode === 'interaction_required' ||
          error.name === 'BrowserAuthError' ||
          error.errorCode?.includes('popup_window_error') ||
          error.message?.includes('interaction_required') ||
          error.message?.includes('AADSTS');

        if (!isAuthError) {
          console.warn('Profile photo fetch failed:', error.message || error);
        }

        setProfilePhoto(null);
      } finally {
        setPhotoLoading(false);
        hasFetchedRef.current  = true;
        isFetchingRef.current  = false;
      }
    };

    fetchProfilePhoto();

    // cleanup uses local `objectUrl`, not stale `profilePhoto` state
    return () => {
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
      }
    };
  }, [user?.username, accounts.length, instance, onSessionExpired]);

  return { profilePhoto, photoLoading };
};