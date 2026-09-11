/** Decorative artwork only: no timer, state inference, or release signal. */
export function CourierScene() {
  return (
    <div className="courier-scene" aria-hidden="true">
      <div className="courier-orbit courier-orbit-outer" />
      <div className="courier-orbit courier-orbit-inner" />
      <span className="courier-star courier-star-one">✦</span>
      <span className="courier-star courier-star-two">✦</span>
      <div className="courier-letter courier-letter-back" />
      <div className="courier-letter courier-letter-front">
        <span className="letter-address" />
        <span className="letter-seal">V</span>
      </div>
      <img
        className="courier-scene-icon"
        src="/vidha-icon.svg"
        width="512"
        height="512"
        alt=""
      />
      <span className="courier-scene-caption">
        A little care, carried forward.
      </span>
    </div>
  );
}
