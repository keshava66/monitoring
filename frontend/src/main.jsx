import React from 'react';
import ReactDOM from 'react-dom/client';
import { PublicClientApplication, EventType } from '@azure/msal-browser';
import { MsalProvider } from '@azure/msal-react';
import './index.css';
import App from './App.jsx';
import { msalConfig } from './msalConfig';
import { bindMsal } from './context/AuthContext';
// Applies the saved motion setting before the first paint.
import './utils/motion';

const msalInstance = new PublicClientApplication(msalConfig);
const root = ReactDOM.createRoot(document.getElementById('root'));

function renderFatal(message) {
  root.render(
    <div className="min-h-screen flex items-center justify-center bg-jj-gray-01 p-6">
      <div className="max-w-md w-full bg-white rounded-2xl border border-jj-gray-02 shadow-sm p-8 text-center">
        <h1 className="font-johnson-display text-2xl text-jj-gray-08 mb-2">Unable to start</h1>
        <p className="font-johnson-text text-sm text-jj-gray-06 mb-6">{message}</p>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="px-5 py-2.5 rounded-lg bg-jj-red text-white font-johnson-text text-sm hover:bg-jj-maroon-05 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-jj-red focus-visible:ring-offset-2"
        >
          Reload
        </button>
      </div>
    </div>,
  );
}

async function bootstrap() {
  try {
    await msalInstance.initialize();
    const response = await msalInstance.handleRedirectPromise().catch((err) => {
      console.error('Sign-in redirect failed:', err);
      return null;
    });
    if (response?.account) {
      msalInstance.setActiveAccount(response.account);
    } else if (!msalInstance.getActiveAccount()) {
      const [first] = msalInstance.getAllAccounts();
      if (first) msalInstance.setActiveAccount(first);
    }
    bindMsal(msalInstance);
    msalInstance.addEventCallback((event) => {
      if (event.eventType === EventType.LOGIN_SUCCESS && event.payload?.account) {
        msalInstance.setActiveAccount(event.payload.account);
      }
    });
    root.render(
      <React.StrictMode>
        <MsalProvider instance={msalInstance}>
          <App />
        </MsalProvider>
      </React.StrictMode>,
    );
  } catch (err) {
    console.error('Authentication library failed to initialise:', err);
    renderFatal('The sign-in service could not be initialised. Check your network connection and try again.');
  }
}

bootstrap();
