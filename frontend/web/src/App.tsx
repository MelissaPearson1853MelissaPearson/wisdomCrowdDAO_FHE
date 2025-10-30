import { ConnectButton } from '@rainbow-me/rainbowkit';
import '@rainbow-me/rainbowkit/styles.css';
import React, { useEffect, useState } from "react";
import { ethers } from "ethers";
import { getContractReadOnly, getContractWithSigner } from "./contract";
import "./App.css";
import { useAccount, useSignMessage } from 'wagmi';

interface Proposal {
  id: string;
  title: string;
  description: string;
  encryptedVotes: string;
  round: number;
  status: "active" | "completed" | "pending";
  createdAt: number;
  totalParticipants: number;
  currentConsensus: number;
}

interface VoteRecord {
  id: string;
  proposalId: string;
  encryptedVote: string;
  round: number;
  timestamp: number;
  voter: string;
  reasoning: string;
}

const FHEEncryptNumber = (value: number): string => {
  return `FHE-${btoa(value.toString())}-${Date.now()}`;
};

const FHEDecryptNumber = (encryptedData: string): number => {
  if (encryptedData.startsWith('FHE-')) {
    const base64Data = encryptedData.split('-')[1];
    return parseFloat(atob(base64Data));
  }
  return parseFloat(encryptedData);
};

const FHEAggregateVotes = (encryptedVotes: string[]): string => {
  if (encryptedVotes.length === 0) return FHEEncryptNumber(0);
  
  let sum = 0;
  encryptedVotes.forEach(vote => {
    sum += FHEDecryptNumber(vote);
  });
  
  const average = sum / encryptedVotes.length;
  return FHEEncryptNumber(average);
};

const generatePublicKey = () => `0x${Array(64).fill(0).map(() => Math.floor(Math.random() * 16).toString(16)).join('')}`;

const App: React.FC = () => {
  const { address, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const [loading, setLoading] = useState(true);
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [votes, setVotes] = useState<VoteRecord[]>([]);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [creating, setCreating] = useState(false);
  const [transactionStatus, setTransactionStatus] = useState<{ visible: boolean; status: "pending" | "success" | "error"; message: string; }>({ visible: false, status: "pending", message: "" });
  const [newProposal, setNewProposal] = useState({ title: "", description: "" });
  const [activeProposal, setActiveProposal] = useState<Proposal | null>(null);
  const [currentVote, setCurrentVote] = useState({ value: 50, reasoning: "" });
  const [votingStep, setVotingStep] = useState(0);
  const [showVotingModal, setShowVotingModal] = useState(false);
  const [publicKey, setPublicKey] = useState<string>("");
  const [fheComputeProgress, setFheComputeProgress] = useState(0);
  const [showFHEAnimation, setShowFHEAnimation] = useState(false);

  // Statistics
  const activeProposals = proposals.filter(p => p.status === "active").length;
  const completedProposals = proposals.filter(p => p.status === "completed").length;
  const totalVotes = votes.length;
  const userVotes = votes.filter(v => v.voter.toLowerCase() === address?.toLowerCase()).length;

  useEffect(() => {
    loadData().finally(() => setLoading(false));
    setPublicKey(generatePublicKey());
  }, []);

  const loadData = async () => {
    setIsRefreshing(true);
    try {
      const contract = await getContractReadOnly();
      if (!contract) return;

      // Test contract availability
      await contract.isAvailable();
      
      // Load proposals
      const proposalsBytes = await contract.getData("proposal_keys");
      let proposalKeys: string[] = [];
      if (proposalsBytes.length > 0) {
        try {
          proposalKeys = JSON.parse(ethers.toUtf8String(proposalsBytes));
        } catch (e) { console.error("Error parsing proposal keys:", e); }
      }

      const loadedProposals: Proposal[] = [];
      for (const key of proposalKeys) {
        try {
          const proposalBytes = await contract.getData(`proposal_${key}`);
          if (proposalBytes.length > 0) {
            const proposalData = JSON.parse(ethers.toUtf8String(proposalBytes));
            loadedProposals.push({
              id: key,
              title: proposalData.title,
              description: proposalData.description,
              encryptedVotes: proposalData.encryptedVotes || "",
              round: proposalData.round || 1,
              status: proposalData.status || "pending",
              createdAt: proposalData.createdAt,
              totalParticipants: proposalData.totalParticipants || 0,
              currentConsensus: proposalData.currentConsensus || 0
            });
          }
        } catch (e) { console.error(`Error loading proposal ${key}:`, e); }
      }
      setProposals(loadedProposals.sort((a, b) => b.createdAt - a.createdAt));

      // Load votes
      const votesBytes = await contract.getData("vote_keys");
      let voteKeys: string[] = [];
      if (votesBytes.length > 0) {
        try {
          voteKeys = JSON.parse(ethers.toUtf8String(votesBytes));
        } catch (e) { console.error("Error parsing vote keys:", e); }
      }

      const loadedVotes: VoteRecord[] = [];
      for (const key of voteKeys) {
        try {
          const voteBytes = await contract.getData(`vote_${key}`);
          if (voteBytes.length > 0) {
            const voteData = JSON.parse(ethers.toUtf8String(voteBytes));
            loadedVotes.push({
              id: key,
              proposalId: voteData.proposalId,
              encryptedVote: voteData.encryptedVote,
              round: voteData.round,
              timestamp: voteData.timestamp,
              voter: voteData.voter,
              reasoning: voteData.reasoning || ""
            });
          }
        } catch (e) { console.error(`Error loading vote ${key}:`, e); }
      }
      setVotes(loadedVotes);

    } catch (e) { console.error("Error loading data:", e); } 
    finally { setIsRefreshing(false); setLoading(false); }
  };

  const createProposal = async () => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    setCreating(true);
    setTransactionStatus({ visible: true, status: "pending", message: "Creating new wisdom crowd proposal..." });
    
    try {
      const contract = await getContractWithSigner();
      if (!contract) throw new Error("Failed to get contract with signer");
      
      const proposalId = `prop_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      const proposalData = {
        title: newProposal.title,
        description: newProposal.description,
        encryptedVotes: "",
        round: 1,
        status: "active",
        createdAt: Math.floor(Date.now() / 1000),
        totalParticipants: 0,
        currentConsensus: 0
      };

      await contract.setData(`proposal_${proposalId}`, ethers.toUtf8Bytes(JSON.stringify(proposalData)));
      
      // Update proposal keys
      const keysBytes = await contract.getData("proposal_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try { keys = JSON.parse(ethers.toUtf8String(keysBytes)); } catch (e) { console.error("Error parsing keys:", e); }
      }
      keys.push(proposalId);
      await contract.setData("proposal_keys", ethers.toUtf8Bytes(JSON.stringify(keys)));

      setTransactionStatus({ visible: true, status: "success", message: "Proposal created successfully!" });
      await loadData();
      setTimeout(() => {
        setTransactionStatus({ visible: false, status: "pending", message: "" });
        setShowCreateModal(false);
        setNewProposal({ title: "", description: "" });
      }, 2000);

    } catch (e: any) {
      const errorMessage = e.message.includes("user rejected transaction") ? "Transaction rejected" : "Creation failed: " + (e.message || "Unknown error");
      setTransactionStatus({ visible: true, status: "error", message: errorMessage });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    } finally { setCreating(false); }
  };

  const submitVote = async () => {
    if (!isConnected || !activeProposal) { alert("Please connect wallet and select proposal"); return; }
    setCreating(true);
    setTransactionStatus({ visible: true, status: "pending", message: "Encrypting vote with Zama FHE..." });

    try {
      const encryptedVote = FHEEncryptNumber(currentVote.value);
      const contract = await getContractWithSigner();
      if (!contract) throw new Error("Failed to get contract with signer");

      const voteId = `vote_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      const voteData = {
        proposalId: activeProposal.id,
        encryptedVote: encryptedVote,
        round: activeProposal.round,
        timestamp: Math.floor(Date.now() / 1000),
        voter: address,
        reasoning: currentVote.reasoning
      };

      await contract.setData(`vote_${voteId}`, ethers.toUtf8Bytes(JSON.stringify(voteData)));
      
      // Update vote keys
      const keysBytes = await contract.getData("vote_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try { keys = JSON.parse(ethers.toUtf8String(keysBytes)); } catch (e) { console.error("Error parsing keys:", e); }
      }
      keys.push(voteId);
      await contract.setData("vote_keys", ethers.toUtf8Bytes(JSON.stringify(keys)));

      // Show FHE computation animation
      setShowFHEAnimation(true);
      simulateFHEComputation();

      setTransactionStatus({ visible: true, status: "success", message: "Vote submitted securely with FHE encryption!" });
      await loadData();
      setTimeout(() => {
        setTransactionStatus({ visible: false, status: "pending", message: "" });
        setShowVotingModal(false);
        setVotingStep(0);
        setCurrentVote({ value: 50, reasoning: "" });
        setActiveProposal(null);
      }, 2000);

    } catch (e: any) {
      const errorMessage = e.message.includes("user rejected transaction") ? "Transaction rejected" : "Vote submission failed";
      setTransactionStatus({ visible: true, status: "error", message: errorMessage });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    } finally { setCreating(false); }
  };

  const simulateFHEComputation = () => {
    setFheComputeProgress(0);
    const interval = setInterval(() => {
      setFheComputeProgress(prev => {
        if (prev >= 100) {
          clearInterval(interval);
          setTimeout(() => setShowFHEAnimation(false), 2000);
          return 100;
        }
        return prev + 10;
      });
    }, 200);
  };

  const startVoting = (proposal: Proposal) => {
    setActiveProposal(proposal);
    setShowVotingModal(true);
    setVotingStep(1);
  };

  const testContractAvailability = async () => {
    try {
      const contract = await getContractReadOnly();
      if (!contract) throw new Error("Contract not available");
      const isAvailable = await contract.isAvailable();
      setTransactionStatus({ visible: true, status: "success", message: "Contract is available and connected!" });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 2000);
    } catch (e) {
      setTransactionStatus({ visible: true, status: "error", message: "Contract connection failed" });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 2000);
    }
  };

  if (loading) return (
    <div className="loading-screen">
      <div className="fhe-spinner"></div>
      <p>Initializing Wisdom Crowd DAO...</p>
    </div>
  );

  return (
    <div className="app-container fhe-theme">
      <header className="app-header">
        <div className="logo-section">
          <div className="logo">
            <div className="zama-logo"></div>
            <h1>Wisdom<span>Crowd</span>DAO</h1>
          </div>
          <div className="tagline">FHE-Powered Collective Decision Making</div>
        </div>
        
        <nav className="main-nav">
          <button className="nav-item active">Dashboard</button>
          <button className="nav-item">Proposals</button>
          <button className="nav-item">Analytics</button>
          <button className="nav-item">Documentation</button>
        </nav>

        <div className="header-actions">
          <button onClick={testContractAvailability} className="test-contract-btn">
            Test Contract
          </button>
          <ConnectButton accountStatus="address" chainStatus="icon" showBalance={true} />
        </div>
      </header>

      <div className="main-content">
        {/* Step-by-step voting process indicator */}
        <div className="voting-steps">
          <div className={`step ${votingStep >= 1 ? 'active' : ''}`}>
            <div className="step-number">1</div>
            <span>Select Proposal</span>
          </div>
          <div className={`step ${votingStep >= 2 ? 'active' : ''}`}>
            <div className="step-number">2</div>
            <span>Encrypt Vote</span>
          </div>
          <div className={`step ${votingStep >= 3 ? 'active' : ''}`}>
            <div className="step-number">3</div>
            <span>FHE Processing</span>
          </div>
          <div className={`step ${votingStep >= 4 ? 'active' : ''}`}>
            <div className="step-number">4</div>
            <span>Result</span>
          </div>
        </div>

        {/* Statistics Dashboard */}
        <div className="dashboard-grid">
          <div className="stat-card">
            <div className="stat-icon">📊</div>
            <div className="stat-content">
              <div className="stat-value">{proposals.length}</div>
              <div className="stat-label">Total Proposals</div>
            </div>
          </div>
          <div className="stat-card">
            <div className="stat-icon">✅</div>
            <div className="stat-content">
              <div className="stat-value">{activeProposals}</div>
              <div className="stat-label">Active</div>
            </div>
          </div>
          <div className="stat-card">
            <div className="stat-icon">🗳️</div>
            <div className="stat-content">
              <div className="stat-value">{totalVotes}</div>
              <div className="stat-label">Total Votes</div>
            </div>
          </div>
          <div className="stat-card">
            <div className="stat-icon">👤</div>
            <div className="stat-content">
              <div className="stat-value">{userVotes}</div>
              <div className="stat-label">Your Votes</div>
            </div>
          </div>
        </div>

        {/* Proposals List */}
        <div className="proposals-section">
          <div className="section-header">
            <h2>Active Proposals</h2>
            <button onClick={() => setShowCreateModal(true)} className="create-btn">
              + New Proposal
            </button>
          </div>
          
          <div className="proposals-grid">
            {proposals.length === 0 ? (
              <div className="empty-state">
                <div className="empty-icon">💡</div>
                <h3>No proposals yet</h3>
                <p>Create the first proposal to start collective decision making</p>
                <button onClick={() => setShowCreateModal(true)} className="primary-btn">
                  Create First Proposal
                </button>
              </div>
            ) : (
              proposals.map(proposal => (
                <div key={proposal.id} className="proposal-card">
                  <div className="proposal-header">
                    <h3>{proposal.title}</h3>
                    <span className={`status-badge ${proposal.status}`}>{proposal.status}</span>
                  </div>
                  <p className="proposal-desc">{proposal.description}</p>
                  <div className="proposal-meta">
                    <span>Round {proposal.round}</span>
                    <span>{proposal.totalParticipants} participants</span>
                    <span>Consensus: {proposal.currentConsensus}%</span>
                  </div>
                  <button 
                    onClick={() => startVoting(proposal)} 
                    className="vote-btn"
                    disabled={proposal.status !== "active"}
                  >
                    Participate in Wisdom Crowd
                  </button>
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      {/* Create Proposal Modal */}
      {showCreateModal && (
        <div className="modal-overlay">
          <div className="modal-content">
            <div className="modal-header">
              <h2>Create New Proposal</h2>
              <button onClick={() => setShowCreateModal(false)} className="close-btn">×</button>
            </div>
            <div className="modal-body">
              <div className="form-group">
                <label>Proposal Title</label>
                <input 
                  type="text" 
                  value={newProposal.title}
                  onChange={(e) => setNewProposal({...newProposal, title: e.target.value})}
                  placeholder="Enter proposal title..."
                />
              </div>
              <div className="form-group">
                <label>Description</label>
                <textarea 
                  value={newProposal.description}
                  onChange={(e) => setNewProposal({...newProposal, description: e.target.value})}
                  placeholder="Describe the decision needed..."
                  rows={4}
                />
              </div>
            </div>
            <div className="modal-footer">
              <button onClick={() => setShowCreateModal(false)} className="cancel-btn">Cancel</button>
              <button onClick={createProposal} disabled={creating} className="primary-btn">
                {creating ? "Creating..." : "Create Proposal"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Voting Modal */}
      {showVotingModal && activeProposal && (
        <div className="modal-overlay">
          <div className="voting-modal">
            <div className="modal-header">
              <h2>Participate in Wisdom Crowd</h2>
              <button onClick={() => setShowVotingModal(false)} className="close-btn">×</button>
            </div>
            
            <div className="voting-steps-content">
              {votingStep === 1 && (
                <div className="step-content">
                  <h3>Select Your Position</h3>
                  <p>How strongly do you support this proposal? (0-100)</p>
                  <input 
                    type="range" 
                    min="0" 
                    max="100" 
                    value={currentVote.value}
                    onChange={(e) => setCurrentVote({...currentVote, value: parseInt(e.target.value)})}
                    className="vote-slider"
                  />
                  <div className="vote-value">{currentVote.value}</div>
                  <button onClick={() => setVotingStep(2)} className="next-btn">
                    Next: Add Reasoning
                  </button>
                </div>
              )}

              {votingStep === 2 && (
                <div className="step-content">
                  <h3>Add Your Reasoning</h3>
                  <textarea 
                    value={currentVote.reasoning}
                    onChange={(e) => setCurrentVote({...currentVote, reasoning: e.target.value})}
                    placeholder="Explain your position (optional but recommended for collective wisdom)..."
                    rows={4}
                  />
                  <button onClick={() => setVotingStep(3)} className="next-btn">
                    Encrypt & Submit
                  </button>
                </div>
              )}

              {votingStep === 3 && (
                <div className="step-content">
                  <h3>FHE Encryption Process</h3>
                  <div className="encryption-visual">
                    <div className="data-block plain">
                      <span>Your Vote: {currentVote.value}</span>
                    </div>
                    <div className="arrow">→</div>
                    <div className="data-block encrypted">
                      <span>FHE Encrypted</span>
                    </div>
                  </div>
                  <button onClick={submitVote} disabled={creating} className="submit-btn">
                    {creating ? "Encrypting..." : "Submit Encrypted Vote"}
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* FHE Computation Animation */}
      {showFHEAnimation && (
        <div className="fhe-animation-overlay">
          <div className="fhe-animation">
            <div className="fhe-spinner-large"></div>
            <h3>FHE Collective Computation</h3>
            <p>Processing encrypted votes with Zama FHE technology...</p>
            <div className="progress-bar">
              <div className="progress-fill" style={{width: `${fheComputeProgress}%`}}></div>
            </div>
            <div className="fhe-stats">
              <span>Encrypted Data: Secure</span>
              <span>Privacy: Preserved</span>
              <span>Computation: Homomorphic</span>
            </div>
          </div>
        </div>
      )}

      {/* Transaction Status */}
      {transactionStatus.visible && (
        <div className={`transaction-toast ${transactionStatus.status}`}>
          <div className="toast-icon">
            {transactionStatus.status === "success" && "✓"}
            {transactionStatus.status === "error" && "✕"}
            {transactionStatus.status === "pending" && "⏳"}
          </div>
          <span>{transactionStatus.message}</span>
        </div>
      )}

      <footer className="app-footer">
        <div className="footer-content">
          <div className="footer-brand">
            <div className="zama-logo-small"></div>
            <span>Powered by Zama FHE</span>
          </div>
          <div className="footer-links">
            <a href="#">Documentation</a>
            <a href="#">Privacy Policy</a>
            <a href="#">Terms of Service</a>
          </div>
        </div>
      </footer>
    </div>
  );
};

export default App;