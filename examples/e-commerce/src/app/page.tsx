import { ServerUser } from "@hexclave/next";
import { Shop } from "@/shop";
import { hexclaveServerApp } from "@/hexclave";

export default async function Home() {
  const users = await hexclaveServerApp.listUsers();
  const shops: [ServerUser, Shop][] = users
    .map((user): [ServerUser, Shop | undefined] => [
      user,
      // SAFETY: this example writes the eCommerceExample metadata below with the Shop contract.
      (user.serverMetadata as { eCommerceExample?: { shop?: Shop } }).eCommerceExample?.shop,
    ])
    .filter((entry): entry is [ServerUser, Shop] => entry[1] !== undefined);
  const currentUser = await hexclaveServerApp.getUser();

  return (
    <>
      <div className="card">
        Welcome to the e-commerce marketplace example!<br />
        <br />
        This example showcases a simple e-commerce marketplace with multiple shops.<br />
        <br />
        {currentUser ? (
          <>
            You are signed in as {currentUser.displayName ?? currentUser.primaryEmail}. <a href="/edit-shop">Edit your shop</a>, or <a href="/handler/sign-out">sign out</a>.
          </>
        ) : (
          <>
            <a href="/handler/sign-in">Sign in</a> to create your own shop.
          </>
        )}
      </div>

      {shops.length === 0 && (
        <div className="card">
          No shops available yet. Sign in to create your own shop.
        </div>
      )}

      {shops.map(shop => (
        <div key={shop[0].id} className="card">
          <h2>{shop[1].displayName}</h2>
          Producted by {shop[0].displayName ?? shop[0].primaryEmail}<br />
          <h3>Products</h3>
          <ul>
            {shop[1].products.map((product, i) => (
              <li key={i}>{product.name} for ${product.dollarPrice}</li>
            ))}
          </ul>
        </div>
      ))}
    </>
  );
}
