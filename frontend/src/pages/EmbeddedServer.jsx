import React, { useState } from 'react';
import refreshIcon from "/icons/JJ_Icon_Refresh_RGB.svg";
import loadingVideo from "/spinner.mp4";

const Icon = ({ src, alt, className = "w-4 h-4", style = {} }) => (
  <img
    src={src}
    alt={alt}
    className={className}
    style={{ filter: 'currentColor', ...style }}
  />
);

export default function EmbeddedServer({ url, title }) {
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError]         = useState(false);

  const handleRetry = () => {
    // Reset state only — does NOT reload the whole app
    setError(false);
    setIsLoading(true);
  };

  return (
    <div className="h-full flex flex-col bg-jj-gray-01">
      <div className="flex-1 relative bg-jj-gray-01">

        {/* Iframe — always in the DOM so onLoad fires; hidden while loading */}
        <iframe
          key={error ? 'error' : 'active'} // remount on retry to re-trigger onLoad
          src={url}
          className={`absolute inset-0 w-full h-full border-0 transition-opacity duration-300 ${
            isLoading ? 'opacity-0' : 'opacity-100'
          }`}
          title={title}
          onLoad={() => { setIsLoading(false); setError(false); }}
          onError={() => { setIsLoading(false); setError(true); }}
          allow="clipboard-read; clipboard-write"
          sandbox="allow-same-origin allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox"
          style={{ visibility: isLoading ? 'hidden' : 'visible' }}
        />

        {/* Loading overlay */}
        {isLoading && !error && (
          <div className="absolute inset-0 flex items-center justify-center bg-jj-gray-01 z-10">
            <div className="text-center">
              <div className="w-32 h-32 mx-auto mb-4 rounded-full overflow-hidden shadow-lg">
                <video
                  autoPlay loop muted playsInline
                  className="w-full h-full object-cover"
                  style={{ outline: 'none' }}
                >
                  <source src={loadingVideo} type="video/mp4" />
                  {/* Fallback spinner if video fails */}
                  <div className="w-full h-full flex items-center justify-center bg-jj-blue-03">
                    <Icon
                      src={refreshIcon} alt="Loading"
                      className="w-12 h-12 animate-spin"
                      style={{ filter: 'brightness(0) invert(1)' }}
                    />
                  </div>
                </video>
              </div>
              <p className="text-jj-gray-07 font-johnson-text text-lg" style={{ lineHeight: '120%' }}>
                Loading {title}...
              </p>
              <p className="text-jj-gray-05 font-johnson-text text-sm mt-2" style={{ lineHeight: '120%' }}>
                Please wait while we connect to the service
              </p>
            </div>
          </div>
        )}

        {/* Error overlay */}
        {error && (
          <div className="absolute inset-0 flex items-center justify-center bg-jj-gray-01 p-6 z-10">
            <div className="max-w-md w-full bg-white rounded-lg shadow-lg border border-jj-gray-03 p-8 text-center">
              <div className="w-16 h-16 bg-red-100 rounded-full flex items-center justify-center mx-auto mb-4">
                <Icon
                  src={refreshIcon} alt="Warning"
                  className="w-8 h-8"
                  style={{ filter: 'invert(27%) sepia(89%) saturate(6943%) hue-rotate(355deg) brightness(94%) contrast(116%)' }}
                />
              </div>
              <h2 className="text-xl font-johnson-display text-jj-gray-08 mb-3" style={{ lineHeight: '110%' }}>
                Unable to load {title}
              </h2>
              <p className="text-jj-gray-06 font-johnson-text mb-6" style={{ lineHeight: '120%' }}>
                This may be due to network issues or the service being temporarily unavailable.
              </p>
              <div className="space-y-3">
                <button
                  onClick={handleRetry}
                  className="w-full px-4 py-2 bg-jj-red text-white rounded-md hover:bg-jj-maroon-05 transition-colors font-johnson-text flex items-center justify-center space-x-2"
                  onMouseDown={e => e.preventDefault()}
                >
                  <Icon
                    src={refreshIcon} alt="Retry"
                    className="w-4 h-4"
                    style={{ filter: 'brightness(0) invert(1)' }}
                  />
                  <span>Retry</span>
                </button>
                <button
                  onClick={() => window.open(url, '_blank', 'noopener,noreferrer')}
                  className="w-full px-4 py-2 border border-jj-gray-03 text-jj-gray-07 rounded-md hover:bg-jj-gray-01 transition-colors font-johnson-text"
                  onMouseDown={e => e.preventDefault()}
                >
                  Open in new tab
                </button>
              </div>
            </div>
          </div>
        )}

      </div>
    </div>
  );
}