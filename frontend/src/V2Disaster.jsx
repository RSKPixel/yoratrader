import { Field, Segmented } from "./V2Controls";

// The 10% disaster stop switch (backend disaster.py) for the mean-reversion models: a position is out
// 10% from its entry if the day's low (long) / high (short), or its live price, reaches it. Ernest
// Chan: a stop usually lowers a mean-reversion backtest, but caps a disaster if the model stops working.
export default function DisasterStop({ value, onChange, hits }) {
  return (
    <Field
      label="Disaster stop 10%"
      hint={`Out 10% from the entry if the day's low (long) or high (short) reaches it. Chan: a stop usually costs a mean-reversion model a little, but caps the loss if it stops working (a regime change, a black swan).${hits != null ? ` Fired on ${hits} backtest positions.` : ""}`}
    >
      <div className="self-start">
        <Segmented
          label="Disaster stop"
          options={[
            ["on", "On"],
            ["off", "Off"],
          ]}
          value={value}
          onChange={onChange}
        />
      </div>
    </Field>
  );
}
