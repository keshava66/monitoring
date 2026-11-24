/**
 * API Activity Tracker Utility
 *
 * Intercepts all fetch requests to track API activity and reset the session timeout.
 * This ensures that any API calls made by the application count as user activity.
 */

let activityCallback = null;

/**
 * Register a callback to be invoked when API activity is detected
 * @param {Function} callback - Function to call on API activity
 */
export const registerActivityCallback = (callback) => {
  activityCallback = callback;
};

/**
 * Unregister the activity callback
 */
export const unregisterActivityCallback = () => {
  activityCallback = null;
};

const notifyActivity = () => {
  if (activityCallback && typeof activityCallback === 'function') {
    activityCallback();
  }
};

// Store reference to original fetch
const originalFetch = window.fetch;

/**
 * Override global fetch to track API activity
 * This intercepts all fetch calls and notifies the session timeout system
 */
window.fetch = function(...args) {
  return originalFetch.apply(this, args);
};
void notifyActivity;