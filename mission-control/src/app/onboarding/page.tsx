'use client';

import React, { useEffect, useState } from 'react';
import { useSession } from 'next-auth/react';
import { useRouter } from 'next/navigation';
import styles from './page.module.css';

interface Repo {
  id: number;
  full_name: string;
  description: string;
}

export default function Onboarding() {
  const { data: session, status } = useSession();
  const [repos, setRepos] = useState<Repo[]>([]);
  const [loading, setLoading] = useState(true);
  const [existingIds, setExistingIds] = useState<string[]>([]);
  const router = useRouter();

  useEffect(() => {
    const saved = localStorage.getItem('mesh_workspaces');
    if (saved) {
      const parsed = JSON.parse(saved);
      setExistingIds(parsed.map((ws: any) => ws.id));
    }

    if (status === 'unauthenticated') {
      router.push('/login');
    } else if (status === 'authenticated' && session) {
      // @ts-ignore
      const token = session.accessToken;
      if (token) {
        fetch('https://api.github.com/user/repos?sort=updated&per_page=12', {
          headers: {
            Authorization: `Bearer ${token}`
          }
        })
        .then(res => res.json())
        .then(data => {
          if (Array.isArray(data)) {
            setRepos(data);
          }
          setLoading(false);
        })
        .catch(err => {
          console.error(err);
          setLoading(false);
        });
      } else {
        setLoading(false);
      }
    }
  }, [status, session, router]);

  const handleAddWorkspace = (repo: Repo) => {
    const saved = localStorage.getItem('mesh_workspaces');
    let workspaces = saved ? JSON.parse(saved) : [];
    
    // Set all others to inactive
    workspaces = workspaces.map((ws: any) => ({ ...ws, active: false }));
    
    // Create new workspace
    const newWs = {
      id: repo.id.toString(),
      name: repo.full_name.substring(0, 2).toUpperCase(),
      full: repo.full_name,
      active: true
    };
    
    // Add if it doesn't exist
    if (!workspaces.find((ws: any) => ws.id === newWs.id)) {
      workspaces.push(newWs);
    } else {
      // Just make it active if it already exists
      workspaces = workspaces.map((ws: any) => ws.id === newWs.id ? { ...ws, active: true } : ws);
    }
    
    localStorage.setItem('mesh_workspaces', JSON.stringify(workspaces));
    router.push('/');
  };

  if (status === 'loading' || loading) {
    return (
      <div className={styles.container}>
        <div className={styles.loadingText}>Connecting to GitHub...</div>
      </div>
    );
  }

  return (
    <div className={styles.container}>
      <div className={`glass-panel ${styles.card}`}>
        <h1 className={styles.title}>Select a Repository</h1>
        <p className={styles.subtitle}>Choose a GitHub repository to add to your Mesh workspace. This will sync its context into the shared memory bank.</p>
        
        <div className={`${styles.repoList} custom-scrollbar`}>
          {repos.length === 0 ? (
            <div className={styles.empty}>No repositories found or missing permissions.</div>
          ) : (
            repos.map(repo => (
              <div key={repo.id} className={styles.repoItem}>
                <div className={styles.repoInfo}>
                  <div className={styles.repoName}>{repo.full_name}</div>
                  <div className={styles.repoDesc}>{repo.description || 'No description provided.'}</div>
                </div>
                <button 
                  className={styles.addBtn}
                  onClick={() => handleAddWorkspace(repo)}
                >
                  {existingIds.includes(repo.id.toString()) ? 'Open' : 'Add'}
                </button>
              </div>
            ))
          )}
        </div>
        <button className={styles.skipBtn} onClick={() => router.push('/')}>Skip for now</button>
      </div>
    </div>
  );
}
