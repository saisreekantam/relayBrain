'use client';

import React from 'react';
import styles from './SecurityOps.module.css';

export default function SecurityOps() {
  return (
    <div className={`glass-panel ${styles.panel}`}>
      <div className={styles.header}>
        <div className="section-title" style={{ marginBottom: 0 }}>SECURITY OPS</div>
        <div className={styles.threatIndicator}>
          THREAT LEVEL <span className={styles.threatDot}></span> LOW
        </div>
      </div>

      <div className={styles.surfaceList}>
        <span>API Gateway <span className={styles.ok}>✓</span></span>
        <span>DB <span className={styles.ok}>✓</span></span>
        <span>Containers <span className={styles.ok}>✓</span></span>
        <span>Deps <span className={styles.warn}>⚠</span></span>
      </div>

      <div className={styles.vulnCard}>
        <div className={styles.vulnHeader}>
          <span className={styles.vulnBadge}>⚠ MEDIUM</span>
          <span className={styles.vulnId}>CVE-2024-0553</span>
        </div>
        <div className={styles.vulnBody}>
          <div className={styles.vulnTitle}>OpenSSL 3.0.1</div>
          <div className={styles.vulnDetail}>Affected: api-container</div>
          <div className={styles.vulnDetail}>Patch: 3.0.2 available</div>
        </div>
        <div className={styles.vulnActions}>
          <button className={styles.actionBtnPrimary}>Auto-Patch</button>
          <button className={styles.actionBtnSecondary}>Dismiss</button>
        </div>
      </div>

      <div className={styles.complianceStrip}>
        <div className={styles.compItem}>SOC2 <span className={styles.ok}>● PASS</span></div>
        <div className={styles.compItem}>OWASP <span className={styles.warn}>⚠ 1 WARN</span></div>
        <div className={styles.compItem}>GDPR <span className={styles.ok}>● PASS</span></div>
      </div>
    </div>
  );
}
