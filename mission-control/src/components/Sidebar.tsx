'use client';

import React, { useState } from 'react';
import styles from './Sidebar.module.css';

const projects = [
  { id: '1', title: 'Orbit OS', active: true },
  { id: '2', title: 'Secure SaaS', active: false },
  { id: '3', title: 'Internal API', active: false },
];

const navigation = [
  { id: 'dash', title: 'Dashboard' },
  { id: 'chat', title: 'Group Chat', badge: 3 },
  { id: 'team', title: 'Agents' },
  { id: 'ci', title: 'CI/CD Pipeline' },
  { id: 'gateway', title: 'Gateway' },
];

export default function Sidebar() {
  const [selectedNav, setSelectedNav] = useState('chat');
  const [selectedProj, setSelectedProj] = useState('1');

  return (
    <aside className={styles.sidebar}>
      <div className={styles.logoSection}>
        <h1 className={styles.logoText}>DevSecOps</h1>
      </div>

      <div className={styles.section}>
        <div className={styles.projectHeader}>
          <div className={styles.projectIcon}>
            <span className={styles.innerIcon}>O</span>
          </div>
          <div className={styles.projectInfo}>
            <div className={styles.projectTitle}>Orbit OS</div>
            <div className={styles.projectSub}>Current Project</div>
          </div>
        </div>
      </div>

      <div className={styles.navSection}>
        <div className={styles.sectionTitle}>WORKSPACES</div>
        {projects.map(proj => (
          <div 
            key={proj.id} 
            className={`${styles.navItem} ${selectedProj === proj.id ? styles.active : ''}`}
            onClick={() => setSelectedProj(proj.id)}
          >
            <span className={styles.itemHash}>#</span>
            <span className={styles.itemTitle}>{proj.title}</span>
          </div>
        ))}
      </div>

      <div className={styles.navSection}>
        <div className={styles.sectionTitle}>PLATFORM</div>
        {navigation.map(nav => (
          <div 
            key={nav.id} 
            className={`${styles.navItem} ${selectedNav === nav.id ? styles.active : ''}`}
            onClick={() => setSelectedNav(nav.id)}
          >
            <span className={styles.itemTitle}>{nav.title}</span>
            {nav.badge && <span className={styles.badge}>{nav.badge}</span>}
          </div>
        ))}
      </div>

      <div className={styles.spacer}></div>

      <div className={styles.userSection}>
        <div className={styles.userAvatar}>JD</div>
        <div className={styles.userInfo}>
          <div className={styles.userName}>John Doe</div>
          <div className={styles.userRole}>Operator</div>
        </div>
      </div>
    </aside>
  );
}
