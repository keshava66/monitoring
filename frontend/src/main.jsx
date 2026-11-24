import React from 'react'
import ReactDOM from 'react-dom/client'
import './index.css'
import App from './App.jsx'
import { PublicClientApplication, EventType } from '@azure/msal-browser'
import { MsalProvider } from '@azure/msal-react'
import { msalConfig } from './msalConfig'

// Initialize MSAL instance
const msalInstance = new PublicClientApplication(msalConfig);

// Handle redirect promise and initialize
msalInstance.initialize().then(() => {
  // Account selection logic is app dependent. Adjust as needed for different use cases.
  const accounts = msalInstance.getAllAccounts();
  if (accounts.length > 0) {
    msalInstance.setActiveAccount(accounts[0]);
  }

  msalInstance.addEventCallback((event) => {
    if (event.eventType === EventType.LOGIN_SUCCESS && event.payload.account) {
      const account = event.payload.account;
      msalInstance.setActiveAccount(account);
    }
  });

  // Handle redirect promise - CRITICAL for fixing redirect loop
  msalInstance.handleRedirectPromise()
    .then((response) => {
      if (response !== null) {
        // Handle successful redirect - set active account
        msalInstance.setActiveAccount(response.account);
      }

      // Render app after handling redirect
      ReactDOM.createRoot(document.getElementById('root')).render(
        <React.StrictMode>
          <MsalProvider instance={msalInstance}>
            <App />
          </MsalProvider>
        </React.StrictMode>,
      );
    })
    .catch((error) => {
      console.error('Redirect error:', error);

      // Render app even if there's an error
      ReactDOM.createRoot(document.getElementById('root')).render(
        <React.StrictMode>
          <MsalProvider instance={msalInstance}>
            <App />
          </MsalProvider>
        </React.StrictMode>,
      );
    });
}).catch(error => {
  console.error('MSAL initialization error:', error);
});