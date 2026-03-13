# Architecture overview
Orchestrator calls for multiple http requests. For that reason, it was decided to build a general function _callService_ that would make post requests and fill in traces. The function takes _step -_ payment / inventory / shipping / notification, _url -_ url of the service endpoint, _payload -_ user data to carry through the services and _trace_ - array to track request metadata. The function indicates whether a service has failed due to timeout or other error.

_/checkout_ endpoint defines common trace array that will be passed to each service. User request is passed to _/payment/authorize_, _/inventory/reserve_, _/shipping/create_, _/notification/send_ endpoints. If none fails response is completed, persistent data is written to idempotency-store and saga-store. If a call to service triggers an error then compensation logic takes place. Each service call has its own Boolean variable (_paymentDone_, _inventoryDone_, _shippingDone_) with the help of this it is possible to define which service failed and call the right compensation.

Strict sequence is enforced by separate asynchronous http requests for each service only once in the code in the right order.

Each step emits a trace with the help of _callService_ function what ensures same format for traces.

Timeout behaviour is implemented in _callService_ via Axios timeout where it throws an error with respective error code. Then in _/checkout_ endpoint service timeout error is determined by previously-mentioned error code and HTTP 504 is assigned.

Compensation strategy is completely enclosed in _/checkout_ endpoint.

Idempotency policy is also located in _/checkout_ endpoint. Only 3 three possible cases are provided therein if a record with the same idempotency key as in the request exists.

- Same idempotency key but different payload triggers HTTP 409 end stops execution
- Same idempotency key and same payload given that previous request was successfully completed returns HTTP 200 and replays stored response
- Same idempotency key and same payload given that previous request is in progress returns HTTP 409 because of idempotency conflict

Idempotency-store and saga-store store data both for in-progress and terminal states and keep data after container restart.

AI was used to set the general structure for _/checkout_ endpoint in order to limit syntax errors and add informative console logs. Detailed logic was done manually.
