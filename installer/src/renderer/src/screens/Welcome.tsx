interface WelcomeProps {
  onGetStarted: () => void;
}

export default function Welcome({ onGetStarted }: WelcomeProps): React.JSX.Element {
  return (
    <main className="screen">
      <h1>Welcome to Granted</h1>
      <p className="subtitle">
        This wizard will get your machine ready to run Granted, the federal-grant-matching
        assistant, on this computer.
      </p>
      <div className="actions">
        <button type="button" className="primary" onClick={onGetStarted}>
          Get Started
        </button>
      </div>
    </main>
  );
}
