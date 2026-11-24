import React, { createContext, useContext, useEffect, useRef, useState, useCallback } from 'react';
import ReactDOM from 'react-dom';
import { useAuth } from './AuthContext';
import alertSrc from "/icons/JJ_Icon_Alert_RGB.svg";
import timerSrc from "/icons/JJ_Icon_Timer_RGB.svg";
import { registerActivityCallback, unregisterActivityCallback } from './apiActivityTracker';

const SessionTimeoutContext = createContext();

const INACTIVITY_TIMEOUT = 15 * 60 * 1000; // 15 minutes
const WARNING_TIME       = 13 * 60 * 1000; // show warning at 13 min
const WARNING_DURATION   = 120;            // 120-second countdown

// mousemove fires hundreds of times per second — debounce to avoid
// hammering the timer reset on every pixel of cursor movement.
function debounce(fn, ms) {
  let timer;
  const debounced = (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
  debounced.cancel = () => clearTimeout(timer);
  return debounced;
}

function SessionTimeoutProvider({ children }) {
  const { logout, authenticated } = useAuth();
  const [modalVisible, setModalVisible]   = useState(false);
  const [countdown, setCountdown]         = useState(WARNING_DURATION);

  const timeoutRef         = useRef(null);
  const warningTimeoutRef  = useRef(null);
  const countdownIntervalRef = useRef(null);
  const isWarningShowing   = useRef(false);

  const clearAllTimers = useCallback(() => {
    clearTimeout(timeoutRef.current);
    clearTimeout(warningTimeoutRef.current);
    clearInterval(countdownIntervalRef.current);
    timeoutRef.current = warningTimeoutRef.current = countdownIntervalRef.current = null;
  }, []);

  const startTimers = useCallback(() => {
    if (!authenticated) return;
    clearAllTimers();
    isWarningShowing.current = false;

    warningTimeoutRef.current = setTimeout(() => {
      isWarningShowing.current = true;
      setModalVisible(true);
      setCountdown(WARNING_DURATION);
      let remaining = WARNING_DURATION;
      countdownIntervalRef.current = setInterval(() => {
        remaining--;
        setCountdown(remaining);
        if (remaining <= 0) clearInterval(countdownIntervalRef.current);
      }, 1000);
    }, WARNING_TIME);

    timeoutRef.current = setTimeout(() => {
      clearAllTimers();
      setModalVisible(false);
      isWarningShowing.current = false;
      logout('session_expired');
    }, INACTIVITY_TIMEOUT);
  }, [authenticated, clearAllTimers, logout]);

  const handleStayLoggedIn = useCallback(() => {
    setModalVisible(false);
    isWarningShowing.current = false;
    startTimers();
  }, [startTimers]);

  const handleActivity = useCallback(() => {
    if (!isWarningShowing.current) startTimers();
  }, [startTimers]);

  useEffect(() => {
    if (!authenticated) {
      clearAllTimers();
      setModalVisible(false);
      isWarningShowing.current = false;
      unregisterActivityCallback();
      return;
    }

    startTimers();
    registerActivityCallback(handleActivity);

    // High-frequency events get a debounced handler so they don't hammer
    // the timer reset on every pixel of cursor movement.
    const debouncedMouseMove = debounce(handleActivity, 500);
    const discreteEvents = ['mousedown', 'keypress', 'keydown', 'click', 'scroll', 'touchstart'];
    discreteEvents.forEach(e => window.addEventListener(e, handleActivity, { passive: true }));
    window.addEventListener('mousemove', debouncedMouseMove, { passive: true });

    return () => {
      discreteEvents.forEach(e => window.removeEventListener(e, handleActivity));
      window.removeEventListener('mousemove', debouncedMouseMove);
      debouncedMouseMove.cancel();
      unregisterActivityCallback();
      clearAllTimers();
    };
  }, [authenticated, startTimers, handleActivity, clearAllTimers]);

  return (
    <SessionTimeoutContext.Provider value={{ resetTimers: startTimers }}>
      {children}
      {modalVisible && authenticated && ReactDOM.createPortal(
        <SessionTimeoutModal countdown={countdown} onStayLoggedIn={handleStayLoggedIn} />,
        document.body
      )}
    </SessionTimeoutContext.Provider>
  );
}

function SessionTimeoutModal({ countdown, onStayLoggedIn }) {
  return (
    <div style={{ position:'fixed', inset:0, zIndex:999999, backgroundColor:'rgba(0,0,0,0.7)', backdropFilter:'blur(4px)', display:'flex', alignItems:'center', justifyContent:'center', padding:'1rem' }}>
      <div style={{ backgroundColor:'white', borderRadius:'1rem', maxWidth:'28rem', width:'100%', boxShadow:'0 25px 50px -12px rgba(0,0,0,0.5)', border:'4px solid #fbe058', overflow:'hidden' }}>
        {/* Header */}
        <div style={{ background:'linear-gradient(to right, #fbe058, #ff6017)', padding:'1.5rem', display:'flex', alignItems:'center', gap:'0.75rem' }}>
          <div style={{ width:'3rem', height:'3rem', backgroundColor:'white', borderRadius:'50%', display:'flex', alignItems:'center', justifyContent:'center' }}>
            <img src={alertSrc} alt="" style={{ width:'1.75rem', height:'1.75rem', filter:'brightness(0) saturate(100%) invert(48%) sepia(97%) saturate(2446%) hue-rotate(347deg) brightness(102%) contrast(105%)' }} />
          </div>
          <h2 style={{ fontSize:'1.25rem', fontWeight:'bold', fontFamily:'JohnsonDisplay, Arial, sans-serif', color:'#312c2a', margin:0 }}>
            Session Timeout Warning
          </h2>
        </div>
        {/* Body */}
        <div style={{ padding:'1.5rem' }}>
          {/* Countdown circle */}
          <div style={{ display:'flex', justifyContent:'center', marginBottom:'1.5rem' }}>
            <div style={{ position:'relative', width:'8rem', height:'8rem' }}>
              <svg style={{ transform:'rotate(-90deg)', width:'8rem', height:'8rem' }}>
                <circle cx="64" cy="64" r="56" stroke="#f1efed" strokeWidth="8" fill="none" />
                <circle cx="64" cy="64" r="56" stroke="#eb1700" strokeWidth="8" fill="none"
                  strokeDasharray={`${2 * Math.PI * 56}`}
                  strokeDashoffset={`${2 * Math.PI * 56 * (1 - countdown / WARNING_DURATION)}`}
                  strokeLinecap="round"
                  style={{ transition:'stroke-dashoffset 1s linear' }} />
              </svg>
              <div style={{ position:'absolute', inset:0, display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center' }}>
                <img src={timerSrc} alt="" style={{ width:'2rem', height:'2rem', marginBottom:'0.25rem', filter:'brightness(0) saturate(100%) invert(17%) sepia(100%) saturate(7426%) hue-rotate(3deg) brightness(92%) contrast(118%)' }} />
                <span style={{ fontSize:'3rem', fontWeight:'bold', color:'#eb1700', fontFamily:'JohnsonDisplay, Arial, sans-serif', lineHeight:1 }}>{countdown}</span>
                <span style={{ fontSize:'0.75rem', color:'#6e6259', fontFamily:'JohnsonText, Arial, sans-serif' }}>seconds</span>
              </div>
            </div>
          </div>
          {/* Message */}
          <div style={{ textAlign:'center', marginBottom:'1.5rem' }}>
            <p style={{ fontSize:'1rem', color:'#312c2a', fontFamily:'JohnsonText, Arial, sans-serif', lineHeight:'1.625', margin:'0 0 0.5rem 0' }}>
              You'll be logged out in <span style={{ fontWeight:'bold', color:'#eb1700' }}>{countdown} seconds</span> due to inactivity.
            </p>
            <p style={{ fontSize:'0.875rem', color:'#6e6259', fontFamily:'JohnsonText, Arial, sans-serif', margin:0 }}>
              Click "Stay Logged In" to extend your session.
            </p>
          </div>
          {/* Button */}
          <button
            onClick={onStayLoggedIn}
            style={{ width:'100%', padding:'1rem 1.5rem', background:'linear-gradient(to right, #eb1700, #9e0000)', color:'white', borderRadius:'0.75rem', fontWeight:'bold', fontFamily:'JohnsonText, Arial, sans-serif', fontSize:'1.125rem', border:'none', cursor:'pointer', display:'flex', alignItems:'center', justifyContent:'center', gap:'0.75rem' }}
          >
            Stay Logged In
          </button>
          <p style={{ fontSize:'0.75rem', color:'#a39992', fontFamily:'JohnsonText, Arial, sans-serif', textAlign:'center', marginTop:'1rem', marginBottom:0 }}>
            Your session will extend for another 15 minutes
          </p>
        </div>
      </div>
    </div>
  );
}

export function useSessionTimeout() {
  const context = useContext(SessionTimeoutContext);
  if (!context) throw new Error('useSessionTimeout must be used within a SessionTimeoutProvider');
  return context;
}

export { SessionTimeoutProvider };