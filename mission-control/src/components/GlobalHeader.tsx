'use client';

import React from 'react';
import styles from './GlobalHeader.module.css';

export default function GlobalHeader() {
  return (
    <header className={styles.header}>
      <div className={styles.left}>
        <div className={styles.logo}>ORBIT OS</div>
        <div className={styles.projectDropdown}>
          Secure SaaS <span className={styles.arrow}>▼</span>
        </div>
      </div>
      
      <div className={styles.center}>
        <div className={styles.liveIndicator}>
          <span className={styles.dot}></span> LIVE
        </div>
        <div className={styles.controls}>
          <button className={styles.controlBtn}>Pause</button>
          <button className={styles.controlBtn}>Step</button>
        </div>
      </div>

      <div className={styles.right}>
        <div className={styles.stats}>
          <span>Tokens: <strong className="mono">142k</strong></span>
          <span>Cost: <strong className="mono">$0.34</strong></span>
        </div>
        <button className={styles.settingsBtn}>Settings</button>
        <button className={styles.stopBtn}>STOP</button>
      </div>
    </header>
  );
}
